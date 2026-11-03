import { createSign } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import type { Bus } from "./bus.ts";
import type { Database } from "./db.ts";
import type { Files } from "./files.ts";
import type { JobContext, Jobs } from "./jobs.ts";
import { HttpError, typeFor } from "./lib/http.ts";
import { secrets } from "./lib/secrets.ts";
import type { Team, Viewer } from "./team/team.ts";
import { isAdmin } from "./team/team.ts";

/**
 * A service account can only reach the Shared Drives it has been added to, so the full Drive scope is
 * bounded by that membership. drive.file would also cover files this app creates, but Google's docs don't
 * say it covers a Shared Drive's root, which is where the first folder goes.
 */
const SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SECRET = "drive_service_account";
/** Upload chunks must be multiples of 256 KiB. 16 MiB keeps retries cheap on slow links. */
export const CHUNK = 64 * 256 * 1024;

export type ServiceAccount = { client_email: string; private_key: string; token_uri?: string; project_id?: string };

export function parseServiceAccount(text: string): ServiceAccount {
  let v: Partial<ServiceAccount> & { type?: string };
  try {
    v = JSON.parse(text);
  } catch {
    throw new HttpError(400, "That isn't the JSON key file. Download it from Google Cloud Console → Service accounts → Keys.");
  }
  if (v.type !== "service_account" || !v.client_email || !v.private_key?.includes("PRIVATE KEY")) throw new HttpError(400, "That JSON isn't a service account key.");
  return { client_email: v.client_email, private_key: v.private_key, token_uri: v.token_uri, project_id: v.project_id };
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** A signed JWT exchanged for an access token, as Google documents for server-to-server calls. */
export function signAssertion(sa: ServiceAccount, now = Math.floor(Date.now() / 1000)) {
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${signer.sign(sa.private_key).toString("base64url")}`;
}

/** Names can't break Drive's query syntax. */
export const quoteQuery = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export class DriveSync {
  private db: Database;
  private bus: Bus;
  private files: Files;
  private jobs: Jobs;
  private team: Team;
  private token: { value: string; until: number } | null = null;
  fetcher: typeof fetch = fetch;

  constructor(db: Database, bus: Bus, files: Files, jobs: Jobs, team: Team) {
    this.db = db;
    this.bus = bus;
    this.files = files;
    this.jobs = jobs;
    this.team = team;
    jobs.register<{ libraryId: string }>("library.drive.sync", (p, ctx) => this.sync(p.libraryId, ctx));
  }

  get sharedDriveId() {
    return this.db.setting("drive_shared_drive_id");
  }

  async status() {
    return { connected: !!this.sharedDriveId && (await secrets.has(SECRET)), sharedDriveId: this.sharedDriveId, driveName: this.db.setting("drive_shared_drive_name") };
  }

  private async account() {
    const text = await secrets.get(SECRET);
    if (!text) throw new Error("The company Drive isn't connected. An admin can connect it in Settings → Integrations.");
    return parseServiceAccount(text);
  }

  private async accessToken(signal?: AbortSignal) {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const sa = await this.account();
    const res = await this.fetcher(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST", signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signAssertion(sa) }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`Google refused the service account: ${body.error_description ?? res.status}`);
    this.token = { value: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 120) * 1000 };
    return body.access_token;
  }

  private async call<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const token = await this.accessToken(signal);
    const res = await this.fetcher(`${API}${path}`, { ...init, signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    if (!res.ok) {
      const detail = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(res.status === 404 ? "Drive can't find that Shared Drive. Add the service account to it as a Content manager." : `Google Drive said: ${detail}`);
    }
    return (await res.json()) as T;
  }

  /** Saves the key in the Keychain and checks it can reach the Shared Drive before keeping anything. */
  async connect(actor: Viewer, keyJson: string, sharedDriveId: string) {
    if (!isAdmin(actor)) throw new HttpError(403, "Only admins can connect the company Drive.");
    const id = sharedDriveId.trim();
    if (!/^[\w-]{10,}$/.test(id)) throw new HttpError(400, "Paste the Shared Drive's id: the last part of its address in Google Drive.");
    const sa = parseServiceAccount(keyJson);
    const previous = await secrets.get(SECRET);
    await secrets.set(SECRET, JSON.stringify(sa));
    this.token = null;
    try {
      const drive = await this.call<{ id: string; name: string }>(`/drives/${encodeURIComponent(id)}?fields=id,name`);
      this.db.setSetting("drive_shared_drive_id", drive.id);
      this.db.setSetting("drive_shared_drive_name", drive.name);
      this.team.audit(actor, "drive.connect", "studio", null, null, { drive: drive.name, account: sa.client_email });
      for (const r of this.db.all<{ resource_id: string }>("SELECT DISTINCT resource_id FROM shares WHERE resource_type = 'library'")) this.queue(r.resource_id);
      return { connected: true, driveName: drive.name, account: sa.client_email };
    } catch (e) {
      if (previous) await secrets.set(SECRET, previous);
      else await secrets.remove(SECRET);
      this.token = null;
      throw new HttpError(400, (e as Error).message);
    }
  }

  async disconnect(actor: Viewer) {
    if (!isAdmin(actor)) throw new HttpError(403, "Only admins can disconnect the company Drive.");
    await secrets.remove(SECRET);
    this.db.run("DELETE FROM settings WHERE key IN ('drive_shared_drive_id', 'drive_shared_drive_name')");
    this.token = null;
    this.team.audit(actor, "drive.disconnect", "studio", null, null, null);
  }

  /** One sync per library at a time. New clips that arrive during a sync are picked up by the next pass. */
  queue(libraryId: string) {
    if (!this.sharedDriveId) return null;
    const waiting = this.db.get("SELECT 1 FROM jobs WHERE kind = 'library.drive.sync' AND status = 'queued' AND json_extract(payload, '$.libraryId') = ?", libraryId);
    if (waiting) return null;
    const owner = this.db.get<{ owner_id: string }>("SELECT owner_id FROM libraries WHERE id = ?", libraryId)?.owner_id ?? null;
    return this.jobs.add("library.drive.sync", { libraryId }, { lane: "light", priority: 8, owner });
  }

  private async folderFor(libraryId: string, signal: AbortSignal) {
    const lib = this.db.get<{ name: string; drive_folder_id: string | null; owner_id: string }>("SELECT name, drive_folder_id, owner_id FROM libraries WHERE id = ?", libraryId);
    if (!lib) throw new Error("That library no longer exists.");
    if (lib.drive_folder_id) return lib.drive_folder_id;
    const owner = this.db.get<{ name: string }>("SELECT name FROM members WHERE id = ?", lib.owner_id)?.name ?? "Someone";
    const name = `${lib.name} (${owner}) · ${libraryId.slice(0, 8)}`;
    // A crash between creating the folder and saving its id would leave a stray copy, so look first.
    const found = await this.call<{ files: { id: string }[] }>(`/files?${new URLSearchParams({ q: `name = ${quoteQuery(name)} and mimeType = 'application/vnd.google-apps.folder' and ${quoteQuery(this.sharedDriveId!)} in parents and trashed = false`, corpora: "drive", driveId: this.sharedDriveId!, includeItemsFromAllDrives: "true", supportsAllDrives: "true", fields: "files(id)" })}`, {}, signal);
    const id = found.files[0]?.id ?? (await this.call<{ id: string }>("/files?supportsAllDrives=true&fields=id", { method: "POST", body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [this.sharedDriveId] }) }, signal)).id;
    this.db.run("UPDATE libraries SET drive_folder_id = ? WHERE id = ?", id, libraryId);
    return id;
  }

  private async sync(libraryId: string, ctx: JobContext) {
    if (!this.sharedDriveId) return { uploaded: 0, skipped: "The company Drive isn't connected." };
    if (!this.db.get("SELECT 1 FROM shares WHERE resource_type = 'library' AND resource_id = ?", libraryId)) return { uploaded: 0, skipped: "This library is private now." };
    const folder = await this.folderFor(libraryId, ctx.signal);
    const todo = this.db.all<{ clip_id: string; file_hash: string; name: string }>("SELECT lc.clip_id, c.file_hash, c.name FROM library_clips lc JOIN clips c ON c.id = lc.clip_id WHERE lc.library_id = ? AND lc.drive_file_id IS NULL AND c.status = 'ready'", libraryId);
    let uploaded = 0;
    for (const [i, t] of todo.entries()) {
      if (ctx.signal.aborted) throw new Error("Cancelled");
      ctx.progress(i / todo.length, `Uploading ${t.name} to the company Drive`);
      const file = this.files.get(t.file_hash);
      const id = await this.upload(file.path, t.name, folder, ctx, (v) => ctx.progress((i + v) / todo.length, `Uploading ${t.name} to the company Drive`));
      this.db.run("UPDATE library_clips SET drive_file_id = ? WHERE library_id = ? AND clip_id = ?", id, libraryId, t.clip_id);
      uploaded++;
    }
    if (uploaded) this.bus.emit("library", { changed: libraryId }, "admins");
    return { uploaded };
  }

  /** Google's resumable upload: open a session, send chunks, and ask where to carry on after a failure. */
  async upload(path: string, name: string, parent: string, ctx: Pick<JobContext, "signal">, progress: (v: number) => void = () => {}) {
    const size = statSync(path).size;
    const type = typeFor(path);
    const token = await this.accessToken(ctx.signal);
    const start = await this.fetcher(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id`, {
      method: "POST", signal: ctx.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(size) },
      body: JSON.stringify({ name, parents: [parent] }),
    });
    const session = start.headers.get("location");
    if (!start.ok || !session) throw new Error(`Google Drive wouldn't start the upload (${start.status}).`);
    let offset = 0;
    let failures = 0;
    while (offset < size) {
      const end = Math.min(size, offset + CHUNK) - 1;
      try {
        const res = await this.fetcher(session, {
          method: "PUT", signal: ctx.signal,
          headers: { "Content-Length": String(end - offset + 1), "Content-Range": `bytes ${offset}-${end}/${size}` },
          body: createReadStream(path, { start: offset, end }) as never,
          duplex: "half",
        } as RequestInit);
        if (res.status === 200 || res.status === 201) return ((await res.json()) as { id: string }).id;
        if (res.status !== 308) throw new Error(`Google Drive stopped the upload (${res.status}).`);
        offset = nextOffset(res.headers.get("range"));
        failures = 0;
        progress(offset / size);
      } catch (e) {
        if (ctx.signal.aborted || ++failures > 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
        // Ask Drive how much it actually has before sending more.
        const probe = await this.fetcher(session, { method: "PUT", signal: ctx.signal, headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` } });
        if (probe.status === 200 || probe.status === 201) return ((await probe.json()) as { id: string }).id;
        offset = probe.status === 308 ? nextOffset(probe.headers.get("range")) : 0;
      }
    }
    throw new Error("Google Drive never confirmed the upload.");
  }
}

/** Drive reports what it has as "bytes=0-1234". The next byte to send follows the last one it holds. */
export function nextOffset(range: string | null) {
  const m = range?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}
