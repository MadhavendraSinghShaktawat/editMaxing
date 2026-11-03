import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve, sep } from "node:path";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { Bus } from "./bus.ts";
import type { Accounts } from "./claude/accounts.ts";
import type { Chats } from "./claude/chat.ts";
import { DIRS, HOME, PORT, WEB_DIR } from "./config.ts";
import type { Database } from "./db.ts";
import { json } from "./db.ts";
import type { Docs } from "./docs.ts";
import type { DriveSync } from "./drivesync.ts";
import type { Files } from "./files.ts";
import { HttpError, Router, readJson, sendFile, typeFor } from "./lib/http.ts";
import { ENVATO_URL } from "./mcp.ts";
import type { Ctx } from "./lib/http.ts";
import { run } from "./lib/proc.ts";
import { secrets } from "./lib/secrets.ts";
import type { Jobs } from "./jobs.ts";
import type { Library } from "./library.ts";
import type { Memory } from "./memory.ts";
import type { MotionKind, MotionLibrary } from "./motionlib.ts";
import { MEMORY_AREAS } from "./memory.ts";
import type { PackId, Packs } from "./packs.ts";
import type { Styles } from "./styles.ts";
import type { Access, Grant } from "./team/access.ts";
import { exportMember } from "./team/export.ts";
import { tailscaleServe, tailscaleStatus } from "./team/tailscale.ts";
import { creditBalance, fetchSocialVideo, platformOf, scrapeKeyFor } from "./social.ts";
import { downloadFile, folderVideos, parseDriveLink } from "./drive.ts";
import type { Role, StudioMode, Team, Viewer } from "./team/team.ts";
import { isAdmin } from "./team/team.ts";

export type App = {
  db: Database; bus: Bus; files: Files; jobs: Jobs; accounts: Accounts; chats: Chats; docs: Docs; library: Library; motion: MotionLibrary;
  styles: Styles; memory: Memory; packs: Packs; team: Team; access: Access; drive: DriveSync;
};

/** Studio-wide keys an admin manages. Epidemic Sound is per person, because its licence can't be shared. */
const STUDIO_KEYS = new Set(["openrouter", "google_api_key"]);
const TOOL_KINDS = new Set(["removeBackground", "transcribe", "cutSilences", "reframe", "parallax", "track"]);
const LOCAL_COOKIE = "dojo_session";

/** The Epidemic key each person brings. The Owner keeps the name it had before teams existed. */
export const epidemicKeyFor = (memberId: string | null, ownerId: string) => (!memberId || memberId === ownerId ? "epidemic" : `epidemic:${memberId}`);

/** The token lives in a file only this macOS user can read. */
/** Sends an MCP initialize to Envato and expects a JSON-RPC result back. */
async function envatoReachable() {
  try {
    const res = await fetch(ENVATO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shifu-dojo", version: "1" } } }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok || !text.includes('"result"')) throw new Error(`status ${res.status}`);
  } catch {
    throw new HttpError(502, "Envato's server didn't answer. Check your connection and try again.");
  }
}

export function installToken() {
  const path = join(HOME, "token");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const cookies = (req: IncomingMessage) => new Map((req.headers.cookie ?? "").split(";").map((c) => c.trim()).filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)] as [string, string]));

const LOOPBACK = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

/** On https the cookie gets the __Host- prefix, which browsers only accept as Secure, host-only and on /. */
const memberCookie = (secure: boolean) => (secure ? "__Host-dojo_member" : "dojo_member");
const isSecure = (team: Team, host: string) => !LOOPBACK.has(host) && !!team.hubOrigin?.startsWith("https://");

function setMemberCookie(res: ServerResponse, team: Team, host: string, token: string, maxAge: number) {
  const secure = isSecure(team, host);
  res.setHeader("Set-Cookie", `${memberCookie(secure)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}

function clearMemberCookie(res: ServerResponse, team: Team, host: string) {
  const secure = isSecure(team, host);
  res.setHeader("Set-Cookie", `${memberCookie(secure)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
}

/**
 * Who is asking. The Mac app on this machine proves itself with the install token and is always the Owner.
 * Everyone else, including the Owner on another device, signs in with a passkey to a Hub.
 */
export function identify(req: IncomingMessage, token: string, team: Team): { viewer: Viewer | null; via: "bearer" | "cookie" | null } {
  const host = req.headers.host ?? "";
  if (LOOPBACK.has(host)) {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer && same(bearer, token)) return { viewer: team.ownerViewer(), via: "bearer" };
    const local = cookies(req).get(LOCAL_COOKIE);
    if (local && same(local, token)) return { viewer: team.ownerViewer(), via: "cookie" };
  }
  const session = cookies(req).get(memberCookie(isSecure(team, host)));
  if (session) {
    const viewer = team.viewerFor(session);
    if (viewer) return { viewer, via: "cookie" };
  }
  return { viewer: null, via: null };
}

/**
 * A cookie rides along on any request the browser makes, so changes need proof they came from this site.
 * SameSite=Strict already blocks most of it; the Origin check covers older browsers and same-site subdomains.
 */
export function sameOrigin(req: IncomingMessage, team: Team) {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return true;
  const origin = req.headers.origin;
  if (origin) return team.origins().has(origin);
  return req.headers["sec-fetch-site"] === "same-origin";
}

/** A small fixed window per kind of request. Passkeys resist guessing anyway; this keeps noise down. */
class Window {
  private hits = new Map<string, { n: number; until: number }>();
  check(key: string, max: number, ms = 60_000) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.until < now) this.hits.set(key, { n: 1, until: now + ms });
    else if (++h.n > max) throw new HttpError(429, "Too many tries. Wait a minute and try again.");
  }
}

const must = (v: Viewer | undefined) => {
  if (!v) throw new HttpError(401, "Sign in first.");
  return v;
};
const admin = (v: Viewer) => {
  if (!isAdmin(v)) throw new HttpError(403, "Only admins can do that.");
  return v;
};
const owner = (v: Viewer) => {
  if (v.role !== "owner") throw new HttpError(403, "Only the Owner can do that.");
  return v;
};
const str = (v: unknown, name: string, max = 500) => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `Missing ${name}.`);
  if (v.length > max) throw new HttpError(400, `${name} is too long.`);
  return v;
};

export function buildRouter(app: App) {
  const { db, bus, files, jobs, accounts, chats, docs, library, motion, styles, memory, packs, team, access, drive } = app;
  const r = new Router();
  const body = async <T = Record<string, unknown>>(c: Ctx) => (await c.body()) as T;
  const limits = new Window();
  const device = (c: Ctx) => String(c.req.headers["user-agent"] ?? "").slice(0, 120) || null;

  /** The same answer for someone else's chat as for a missing one, so ids reveal nothing. */
  const ownChat = (v: Viewer, id: string) => {
    const row = db.get<{ owner_id: string | null }>("SELECT owner_id FROM chats WHERE id = ?", id);
    if (!row || row.owner_id !== v.id) throw new HttpError(404, "That chat no longer exists.");
    return chats.row(id);
  };
  const memberOf = (id: string) => {
    const m = team.member(id);
    return m;
  };
  /** A file can be opened by whoever uploaded it, or anyone who can use a library or style built from it. */
  const canOpenFile = (v: Viewer, hash: string) => {
    if (db.get("SELECT 1 FROM file_access WHERE hash = ? AND member_id = ?", hash, v.id)) return true;
    const clip = db.get<{ id: string }>("SELECT id FROM clips WHERE file_hash = ?", hash);
    if (clip && library.clips(v.id).some((c) => c.id === clip.id)) return true;
    const style = db.get<{ id: string }>("SELECT id FROM styles WHERE source_hash = ?", hash);
    return !!style && styles.canUse(v.id, style.id);
  };
  const mustOpenFile = (v: Viewer, hash: string) => {
    if (!canOpenFile(v, hash)) throw new HttpError(404, "That file isn't here.");
  };
  const studioKeys = async () => Object.fromEntries(await Promise.all([...STUDIO_KEYS].map(async (k) => [k, await secrets.has(k)] as const)));
  const myKeys = async (v: Viewer) => ({ ...(await studioKeys()), epidemic: await secrets.has(epidemicKeyFor(v.id, team.owner().id)), scrapecreators: await secrets.has(scrapeKeyFor(v.id)) });
  const directory = () => team.members().filter((m) => m.status === "active").map((m) => ({ id: m.id, name: m.name, role: m.role }));
  const pref = (v: Viewer, key: string, fallback: string) => db.setting(`m:${v.id}:${key}`) ?? (v.role === "owner" ? db.setting(key) : null) ?? fallback;

  // ── Public: who am I, and signing in ─────────────────────────

  r.add("GET", "/api/auth/status", (c) => {
    const v = c.viewer;
    return { ...team.status(), signedIn: !!v, me: v ? { id: v.id, name: v.name, role: v.role, local: v.via === "local" } : null, passkeys: team.mode === "hub" };
  });
  r.add("POST", "/api/auth/invite", async (c) => {
    limits.check("invite", 60);
    return team.inviteInfo(str((await body(c)).token, "invite", 200));
  });
  r.add("POST", "/api/auth/join/options", async (c) => {
    limits.check("join", 30);
    return team.joinOptions(str((await body(c)).token, "invite", 200), team.siteFor(c.req.headers.host ?? ""));
  });
  r.add("POST", "/api/auth/join", async (c) => {
    limits.check("join", 30);
    const b = await body<{ token: string; ticket: string; response: RegistrationResponseJSON }>(c);
    const s = await team.join(str(b.token, "invite", 200), str(b.ticket, "ticket", 100), b.response, device(c));
    setMemberCookie(c.res, team, c.req.headers.host ?? "", s.token, s.maxAge);
    return { ok: true };
  });
  r.add("POST", "/api/auth/login/options", (c) => {
    limits.check("login", 60);
    if (team.mode !== "hub") throw new HttpError(400, "This Mac isn't a Studio Hub.");
    return team.loginOptions(team.siteFor(c.req.headers.host ?? ""));
  });
  r.add("POST", "/api/auth/login", async (c) => {
    limits.check("login", 30);
    const b = await body<{ ticket: string; response: AuthenticationResponseJSON }>(c);
    const s = await team.login(str(b.ticket, "ticket", 100), b.response, device(c));
    setMemberCookie(c.res, team, c.req.headers.host ?? "", s.token, s.maxAge);
    return { ok: true };
  });
  r.add("POST", "/api/auth/logout", (c) => {
    if (c.viewer) team.logout(c.viewer);
    clearMemberCookie(c.res, team, c.req.headers.host ?? "");
    return { ok: true };
  });

  // ── State ────────────────────────────────────────────────────

  r.add("GET", "/api/state", async (c) => {
    const v = must(c.viewer);
    return {
      me: { id: v.id, name: v.name, role: v.role, local: v.via === "local" },
      studio: team.status(),
      members: team.mode === "hub" ? directory() : [],
      clients: team.clients(v),
      accounts: accounts.listFor(v.id),
      chats: chats.list(v.id),
      decisions: chats.openDecisions({ ownerId: v.id }),
      jobs: db.all("SELECT id, kind, status, progress, message, error FROM jobs WHERE status IN ('queued', 'running') AND owner_id = ?", v.id),
      library: library.stats(v.id),
      libraries: library.libraries(v.id),
      styles: styles.list(v.id),
      motion: motion.list(v.id),
      recipes: styles.recipes(v.id),
      memory: memory.list(v),
      memoryAreas: MEMORY_AREAS,
      packs: packs.list(),
      keys: await myKeys(v),
      settings: { account: pref(v, "account", accounts.firstFor(v.id) ?? "default"), model: pref(v, "model", "sonnet"), effort: pref(v, "effort", "medium"), embedModel: library.embedModel, usageCeiling: Number(pref(v, "usage_ceiling", "85")) },
    };
  });
  r.add("GET", "/api/events", (c) => {
    const v = must(c.viewer);
    bus.attach(c.res, Number(c.req.headers["last-event-id"] ?? c.query.get("since") ?? 0), { memberId: v.id, admin: isAdmin(v) });
    return undefined;
  });
  r.add("GET", "/api/doctor", (c) => (must(c.viewer), packs.doctor()));

  // ── My account ───────────────────────────────────────────────

  r.add("GET", "/api/me", (c) => {
    const v = must(c.viewer);
    return { id: v.id, name: v.name, role: v.role, local: v.via === "local", passkeys: team.passkeys(v.id), devices: team.sessions(v.id), currentSession: v.sessionId ?? null };
  });
  r.add("PATCH", "/api/me", async (c) => {
    const v = must(c.viewer);
    team.rename(v, v.id, str((await body(c)).name, "name", 60));
    return { ok: true };
  });
  r.add("POST", "/api/me/passkeys/options", (c) => team.addOptions(must(c.viewer), team.siteFor(c.req.headers.host ?? "")));
  r.add("POST", "/api/me/passkeys", async (c) => {
    const b = await body<{ ticket: string; response: RegistrationResponseJSON }>(c);
    return team.addPasskey(must(c.viewer), str(b.ticket, "ticket", 100), b.response, device(c));
  });
  r.add("DELETE", "/api/me/passkeys/:id", (c) => (team.removePasskey(must(c.viewer), c.params.id), { ok: true }));
  r.add("DELETE", "/api/me/sessions/:id", (c) => {
    const v = must(c.viewer);
    if (!team.sessions(v.id).some((s) => s.id === c.params.id)) throw new HttpError(404, "That device isn't signed in.");
    team.revokeSession(v, c.params.id);
    return { ok: true };
  });
  r.add("GET", "/api/me/export", async (c) => {
    const v = must(c.viewer);
    await sendExport(c, v.id);
    return undefined;
  });

  async function sendExport(c: Ctx, memberId: string) {
    const { zip, name } = await exportMember(db, memberId);
    const size = statSync(zip).size;
    c.res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": size, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-store" });
    const stream = createReadStream(zip);
    stream.pipe(c.res);
    stream.on("close", () => rmSync(zip, { force: true }));
  }

  // ── Studio mode (Owner) ──────────────────────────────────────

  r.add("POST", "/api/studio/mode", async (c) => {
    const v = owner(must(c.viewer));
    const b = await body<{ mode: StudioMode; hubOrigin?: string | null; joinedHub?: string | null }>(c);
    if (!["single", "hub", "joined"].includes(b.mode)) throw new HttpError(400, "A studio is single user, a Studio Hub, or joined to one.");
    return team.setMode(v, b.mode, { hubOrigin: b.hubOrigin, joinedHub: b.joinedHub });
  });
  r.add("POST", "/api/studio/address", async (c) => {
    const v = owner(must(c.viewer));
    if (v.via !== "local") throw new HttpError(403, "Change the Hub's address from the Mac app on the Hub itself.");
    team.setHubOrigin(v, ((await body(c)).hubOrigin as string | null) ?? null);
    return team.status();
  });
  r.add("POST", "/api/studio/close", (c) => team.startClosing(owner(must(c.viewer))));
  r.add("POST", "/api/studio/close/cancel", (c) => team.cancelClosing(owner(must(c.viewer))));
  r.add("POST", "/api/studio/open-hub", async (c) => {
    const v = owner(must(c.viewer));
    if (v.via !== "local") throw new HttpError(403, "This only works in the Mac app.");
    const url = team.joinedHub;
    if (!url) throw new HttpError(400, "Add the Hub's address first.");
    // Passkeys can't run inside the app's window without Apple's associated-domain entitlement, so the Hub opens in the browser.
    await run("/usr/bin/open", [url]);
    return { ok: true };
  });

  // ── Team (admins) ────────────────────────────────────────────

  r.add("GET", "/api/team", (c) => {
    admin(must(c.viewer));
    return { members: team.members(), invites: team.invites(), clients: team.clients(c.viewer!), suggestions: memory.teamSuggestions() };
  });
  r.add("POST", "/api/team/invites", async (c) => {
    const b = await body<{ name: string; role: "admin" | "editor" }>(c);
    return team.invite(must(c.viewer), str(b.name, "name", 60), b.role);
  });
  r.add("DELETE", "/api/team/invites/:id", (c) => (team.revokeInvite(must(c.viewer), c.params.id), { ok: true }));
  r.add("PATCH", "/api/team/members/:id", async (c) => {
    const v = must(c.viewer);
    const b = await body<{ role?: Role; name?: string }>(c);
    if (b.role) team.setRole(v, c.params.id, b.role);
    if (b.name) team.rename(v, c.params.id, b.name);
    return { ok: true };
  });
  r.add("DELETE", "/api/team/members/:id", (c) => (team.remove(must(c.viewer), c.params.id), { ok: true }));
  r.add("GET", "/api/team/members/:id/devices", (c) => (admin(must(c.viewer)), team.sessions(c.params.id)));
  r.add("DELETE", "/api/team/sessions/:id", (c) => (team.revokeSession(admin(must(c.viewer)), c.params.id), { ok: true }));
  r.add("GET", "/api/team/audit", (c) => {
    admin(must(c.viewer));
    const before = Number(c.query.get("before") ?? 0) || undefined;
    return team.log(200, before);
  });

  // ── Users: admins see each member's work, and can remove it ──

  r.add("GET", "/api/users/:id", (c) => {
    admin(must(c.viewer));
    const m = memberOf(c.params.id);
    return {
      member: team.members().find((x) => x.id === m.id),
      chats: chats.history(m.id),
      styles: styles.ownedBy(m.id),
      memory: memory.personalOf(m.id),
      libraries: library.ownedBy(m.id),
      motion: motion.ownedBy(m.id),
      recipes: styles.recipes(m.id),
      // Usage only: plan, limits and sign-in state. Never tokens, keys or the config folder.
      usage: accounts.listFor(m.id).map((a) => ({ id: a.id, label: a.label, kind: a.kind, email: a.email, plan: a.plan, signedIn: a.signedIn, limits: a.limits, limitsAt: a.limitsAt })),
      devices: team.sessions(m.id),
    };
  });
  r.add("GET", "/api/users/:id/chats/:chatId/messages", (c) => {
    const v = admin(must(c.viewer));
    const row = db.get<{ owner_id: string }>("SELECT owner_id FROM chats WHERE id = ?", c.params.chatId);
    if (!row || row.owner_id !== c.params.id) throw new HttpError(404, "That chat doesn't exist.");
    team.audit(v, "user.chat.view", "chat", c.params.chatId, c.params.id, null);
    return { messages: chats.messages(c.params.chatId), outputs: docs.outputs(c.params.chatId) };
  });
  r.add("GET", "/api/users/:id/chats/:chatId/out/:name", (c) => {
    admin(must(c.viewer));
    const row = db.get<{ owner_id: string; cwd: string }>("SELECT owner_id, cwd FROM chats WHERE id = ?", c.params.chatId);
    if (!row || row.owner_id !== c.params.id) throw new HttpError(404, "That chat doesn't exist.");
    const path = join(row.cwd, "out", basename(c.params.name));
    if (!existsSync(path)) throw new HttpError(404, "That file isn't there.");
    sendFile(c.req, c.res, path);
    return undefined;
  });
  r.add("DELETE", "/api/users/:id/chats/:chatId", (c) => {
    const v = admin(must(c.viewer));
    const row = db.get<{ owner_id: string; cwd: string; name: string; mission: string | null }>("SELECT owner_id, cwd, name, mission FROM chats WHERE id = ?", c.params.chatId);
    if (!row || row.owner_id !== c.params.id) throw new HttpError(404, "That chat doesn't exist.");
    chats.end(c.params.chatId);
    db.tx(() => {
      db.run("DELETE FROM review_items WHERE chat_id = ?", c.params.chatId);
      db.run("DELETE FROM edit_docs WHERE chat_id = ?", c.params.chatId);
      db.run("DELETE FROM chats WHERE id = ?", c.params.chatId);
    });
    const dir = resolve(row.cwd);
    if (dir.startsWith(resolve(DIRS.missions) + sep)) rmSync(dir, { recursive: true, force: true });
    team.audit(v, "user.chat.remove", "chat", c.params.chatId, c.params.id, { title: json<{ title?: string }>(row.mission, {}).title ?? row.name });
    return { ok: true };
  });
  r.add("DELETE", "/api/users/:id/styles/:sid", (c) => {
    const v = admin(must(c.viewer));
    if (styles.get(c.params.sid).ownerId !== c.params.id) throw new HttpError(404, "That style doesn't exist.");
    styles.remove(v, c.params.sid, true);
    return { ok: true };
  });
  r.add("DELETE", "/api/users/:id/motion/:mid", (c) => {
    const v = admin(must(c.viewer));
    if (access.ownerOf("motion", c.params.mid) !== c.params.id) throw new HttpError(404, "That saved animation doesn't exist.");
    motion.remove(v, c.params.mid, true);
    return { ok: true };
  });
  r.add("DELETE", "/api/users/:id/memory/:rid", (c) => {
    const v = admin(must(c.viewer));
    if (!memory.personalOf(c.params.id).some((m) => m.id === c.params.rid)) throw new HttpError(404, "That memory doesn't exist.");
    memory.remove(v, c.params.rid, true);
    return { ok: true };
  });
  r.add("DELETE", "/api/users/:id/libraries/:lid", (c) => {
    const v = admin(must(c.viewer));
    if (access.ownerOf("library", c.params.lid) !== c.params.id) throw new HttpError(404, "That library doesn't exist.");
    library.removeLibrary(v, c.params.lid, true);
    return { ok: true };
  });
  r.add("DELETE", "/api/users/:id/libraries/:lid/clips/:cid", (c) => {
    const v = admin(must(c.viewer));
    if (access.ownerOf("library", c.params.lid) !== c.params.id) throw new HttpError(404, "That library doesn't exist.");
    library.removeClip(v, c.params.lid, c.params.cid, true);
    return { ok: true };
  });
  r.add("DELETE", "/api/users/:id/recipes/:rid", (c) => (styles.removeRecipe(admin(must(c.viewer)), c.params.rid, true), { ok: true }));
  r.add("GET", "/api/users/:id/library/:lid/clips", (c) => {
    admin(must(c.viewer));
    if (access.ownerOf("library", c.params.lid) !== c.params.id) throw new HttpError(404, "That library doesn't exist.");
    return library.clips(c.params.id, c.params.lid);
  });
  r.add("GET", "/api/users/:id/export", async (c) => {
    const v = admin(must(c.viewer));
    memberOf(c.params.id);
    team.audit(v, "user.export", "member", c.params.id, c.params.id, null);
    await sendExport(c, c.params.id);
    return undefined;
  });

  // ── Clients ──────────────────────────────────────────────────

  r.add("POST", "/api/clients", async (c) => team.createClient(must(c.viewer), str((await body(c)).name, "name", 80)));
  r.add("PATCH", "/api/clients/:id", async (c) => {
    const b = await body<{ name?: string; members?: string[] }>(c);
    if (b.members !== undefined && !Array.isArray(b.members)) throw new HttpError(400, "Members must be a list.");
    team.updateClient(must(c.viewer), c.params.id, b);
    return { ok: true };
  });
  r.add("DELETE", "/api/clients/:id", (c) => (team.archiveClient(must(c.viewer), c.params.id), { ok: true }));

  // ── Claude accounts: everyone brings their own ───────────────

  r.add("POST", "/api/accounts", async (c) => {
    const v = must(c.viewer);
    const b = await body<{ label?: string; apiKey?: string }>(c);
    const label = b.label?.trim().slice(0, 60) || "Claude account";
    return b.apiKey ? accounts.addApiKey(v.id, label, str(b.apiKey, "API key", 400)) : accounts.create(v.id, label, "subscription");
  });
  r.add("POST", "/api/accounts/:id/login", async (c) => {
    accounts.owned(must(c.viewer).id, c.params.id);
    const b = await body<{ mode?: "claudeai" | "console" }>(c);
    await accounts.login(c.params.id, b.mode === "console" ? "console" : "claudeai");
    return { ok: true };
  });
  r.add("POST", "/api/accounts/:id/login/code", async (c) => {
    accounts.owned(must(c.viewer).id, c.params.id);
    accounts.submitCode(c.params.id, str((await body(c)).code, "code", 512));
    return { ok: true };
  });
  r.add("POST", "/api/accounts/:id/login/cancel", (c) => (accounts.owned(must(c.viewer).id, c.params.id), accounts.cancelLogin(c.params.id), { ok: true }));
  r.add("POST", "/api/accounts/:id/logout", async (c) => (accounts.owned(must(c.viewer).id, c.params.id), await accounts.logout(c.params.id), { ok: true }));
  r.add("POST", "/api/accounts/:id/refresh", async (c) => (accounts.owned(must(c.viewer).id, c.params.id), await accounts.refresh(c.params.id), accounts.get(c.params.id)));
  r.add("DELETE", "/api/accounts/:id", async (c) => (accounts.owned(must(c.viewer).id, c.params.id), await accounts.remove(c.params.id), { ok: true }));

  // ── Chats ────────────────────────────────────────────────────

  r.add("POST", "/api/chats", async (c) => {
    const v = must(c.viewer);
    const b = await body<{ accountId?: string; model?: string; effort?: string; brief?: { styleId?: string | null; script?: unknown }; clientId?: string | null }>(c);
    if (b.brief?.script !== undefined) b.brief.script = typeof b.brief.script === "string" ? b.brief.script.slice(0, 30_000) : undefined;
    if (b.brief?.styleId && !styles.canUse(v.id, b.brief.styleId)) throw new HttpError(404, "That style isn't available to you.");
    if (b.clientId && !(isAdmin(v) || team.onClient(v.id, b.clientId))) throw new HttpError(403, "You don't work on that client.");
    if (b.clientId && !team.clients(v).some((x) => x.id === b.clientId)) throw new HttpError(404, "That client doesn't exist.");
    return chats.create(v.id, { ...b, brief: b.brief as never, clientId: b.clientId ?? null });
  });
  r.add("GET", "/api/chats/:id/messages", (c) => {
    ownChat(must(c.viewer), c.params.id);
    return { messages: chats.messages(c.params.id), decisions: chats.openDecisions({ chatId: c.params.id }) };
  });
  r.add("POST", "/api/chats/:id/messages", async (c) => {
    const v = must(c.viewer);
    ownChat(v, c.params.id);
    const b = await body<{ text?: string; attachments?: { hash: string; role?: string }[] }>(c);
    if (b.text && b.text.length > 20_000) throw new HttpError(400, "That message is too long.");
    const attachments = (b.attachments ?? []).slice(0, 20).map((a) => {
      mustOpenFile(v, a.hash);
      const f = files.get(a.hash);
      const duration = (f.meta as { duration?: number }).duration;
      return { hash: f.hash, name: f.name, role: a.role === "reference" ? "reference" : "footage", path: f.path, kind: f.kind, duration };
    });
    if (!b.text?.trim() && !attachments.length) throw new HttpError(400, "Write a note or attach a file.");
    await chats.send(c.params.id, b.text ?? "", attachments);
    return { ok: true };
  });
  r.add("PATCH", "/api/chats/:id", async (c) => {
    const v = must(c.viewer);
    ownChat(v, c.params.id);
    const b = await body<{ model?: string; effort?: string | null; accountId?: string; brief?: Record<string, string> }>(c);
    if (b.brief?.styleId && !styles.canUse(v.id, b.brief.styleId)) throw new HttpError(404, "That style isn't available to you.");
    if (b.accountId) chats.setAccount(c.params.id, b.accountId);
    if (b.model) chats.setModel(c.params.id, b.model, b.effort ?? null);
    if (b.brief) chats.setBrief(c.params.id, b.brief);
    return chats.view(chats.row(c.params.id));
  });
  r.add("POST", "/api/chats/:id/interrupt", async (c) => (ownChat(must(c.viewer), c.params.id), await chats.interrupt(c.params.id), { ok: true }));
  r.add("DELETE", "/api/chats/:id", (c) => (ownChat(must(c.viewer), c.params.id), chats.end(c.params.id), { ok: true }));
  r.add("GET", "/api/chats/:id/review", (c) => {
    ownChat(must(c.viewer), c.params.id);
    return db.all<{ id: number; at_seconds: number | null; text: string; kind: string; data: string | null }>("SELECT id, at_seconds, text, kind, data FROM review_items WHERE chat_id = ? ORDER BY id", c.params.id).map((i) => ({ id: i.id, atSeconds: i.at_seconds, text: i.text, kind: i.kind, data: json(i.data, null) }));
  });
  r.add("GET", "/api/chats/:id/versions", (c) => (ownChat(must(c.viewer), c.params.id), docs.versions(c.params.id)));
  r.add("POST", "/api/chats/:id/restore", async (c) => {
    const v = must(c.viewer);
    const chat = ownChat(v, c.params.id);
    const version = Number((await body(c)).version);
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, "Pick a version.");
    const out = docs.restore(c.params.id, version);
    // Going back a version says something didn't work. Memory sees it with the notes around it.
    memory.signal({ memberId: v.id, chatId: chat.id, clientId: chat.client_id, kind: "restore", text: `Went back to version ${version} of the edit.` });
    return out;
  });
  r.add("GET", "/api/chats/:id/outputs", (c) => (ownChat(must(c.viewer), c.params.id), docs.outputs(c.params.id)));
  r.add("GET", "/api/chats/:id/out/:name", (c) => {
    const chat = ownChat(must(c.viewer), c.params.id);
    const path = join(chat.cwd, "out", basename(c.params.name));
    if (!existsSync(path)) throw new HttpError(404, "That file isn't there.");
    sendFile(c.req, c.res, path);
    return undefined;
  });
  r.add("POST", "/api/decisions/:id", async (c) => {
    const v = must(c.viewer);
    const d = db.get<{ chat_id: string }>("SELECT chat_id FROM decisions WHERE id = ?", c.params.id);
    if (!d) throw new HttpError(404, "That question has already been closed.");
    ownChat(v, d.chat_id);
    chats.answer(c.params.id, (await body(c)).answer);
    return { ok: true };
  });

  // ── Files ────────────────────────────────────────────────────

  r.add("POST", "/api/files", async (c) => {
    const v = must(c.viewer);
    const name = basename(c.query.get("name") ?? "upload").slice(0, 200);
    const f = await files.fromStream(c.req, name);
    library.grantFile(v.id, f.hash);
    return f;
  });
  r.add("GET", "/api/files/:hash", (c) => {
    const v = must(c.viewer);
    mustOpenFile(v, c.params.hash);
    const f = files.get(c.params.hash);
    sendFile(c.req, c.res, f.path, typeFor(f.name), "private, max-age=31536000, immutable");
    return undefined;
  });

  r.add("GET", "/api/jobs", (c) => {
    const v = must(c.viewer);
    return db.all<{ result: string | null }>("SELECT id, kind, status, progress, message, error, result FROM jobs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100", v.id).map((j) => ({ ...j, result: json(j.result, null) }));
  });
  r.add("DELETE", "/api/jobs/:id", (c) => {
    const v = must(c.viewer);
    const owner = jobs.ownerOf(c.params.id);
    if (owner !== v.id && !isAdmin(v)) throw new HttpError(404, "That job doesn't exist.");
    jobs.cancel(c.params.id);
    return { ok: true };
  });

  // ── B-roll libraries ─────────────────────────────────────────

  r.add("GET", "/api/library", (c) => {
    const v = must(c.viewer);
    const libraryId = c.query.get("libraryId");
    return { stats: library.stats(v.id), libraries: library.libraries(v.id), clips: library.clips(v.id, libraryId), tree: library.tree(v.id, c.query.get("prefix") ?? ""), gaps: library.gaps(v.id), drive: drive.sharedDriveId ? true : false };
  });
  r.add("POST", "/api/libraries", async (c) => library.createLibrary(must(c.viewer), str((await body(c)).name, "name", 80)));
  r.add("PATCH", "/api/libraries/:id", async (c) => (library.renameLibrary(must(c.viewer), c.params.id, str((await body(c)).name, "name", 80)), { ok: true }));
  r.add("DELETE", "/api/libraries/:id", (c) => (library.removeLibrary(must(c.viewer), c.params.id), { ok: true }));
  r.add("PUT", "/api/libraries/:id/shares", async (c) => library.share(must(c.viewer), c.params.id, grantsOf(await body(c))));
  r.add("DELETE", "/api/libraries/:id/clips/:clipId", (c) => (library.removeClip(must(c.viewer), c.params.id, c.params.clipId), { ok: true }));
  r.add("POST", "/api/library/import", async (c) => {
    const v = must(c.viewer);
    const b = await body<{ hashes: string[]; libraryId?: string; collection?: string; rights?: string }>(c);
    if (!Array.isArray(b.hashes) || !b.hashes.length) throw new HttpError(400, "Add some clips.");
    for (const h of b.hashes) mustOpenFile(v, h);
    return { jobs: b.hashes.slice(0, 500).map((h) => library.enqueue(v, h, b.libraryId ?? null, b.collection, null, b.rights ?? null)) };
  });
  r.add("POST", "/api/library/drive", async (c) => {
    const v = must(c.viewer);
    const b = await body<{ links: string[]; libraryId?: string; collection?: string; rights?: string }>(c);
    const libraryId = b.libraryId ?? library.defaultLibrary(v.id);
    access.require(v, "library", libraryId, "add");
    if (!Array.isArray(b.links) || !b.links.length) throw new HttpError(400, "Paste some Drive links.");
    return { job: jobs.add("library.drive", { links: b.links.slice(0, 200), libraryId, collection: b.collection ?? "general", rights: b.rights ?? null }, { lane: "light", owner: v.id }) };
  });
  r.add("POST", "/api/library/analyze", async (c) => {
    const v = must(c.viewer);
    const b = await body<{ count: number; accountId?: string; model?: string; collection?: string }>(c);
    const accountId = b.accountId ?? pref(v, "account", accounts.firstFor(v.id) ?? "");
    accounts.owned(v.id, accountId);
    const count = Math.max(1, Math.min(1000, Math.floor(Number(b.count) || 10)));
    return { job: jobs.add("library.analyze", { count, accountId, model: b.model ?? "sonnet", collection: b.collection ?? null }, { lane: "claude", priority: 8, owner: v.id }) };
  });
  r.add("POST", "/api/library/search", async (c) => library.search(must(c.viewer).id, (await body(c)) as never));
  r.add("GET", "/api/library/browse", (c) => library.browse(must(c.viewer).id, c.query.get("path") ?? ""));
  r.add("GET", "/api/library/shots/:id/filmstrip", (c) => {
    library.mustSeeShot(must(c.viewer).id, c.params.id);
    const s = library.shot(c.params.id);
    sendFile(c.req, c.res, s.filmstrip ?? (s.duplicate_of ? library.shot(s.duplicate_of).filmstrip! : ""), "image/jpeg", "private, max-age=86400");
    return undefined;
  });

  // ── Styles ───────────────────────────────────────────────────

  r.add("POST", "/api/styles/learn", async (c) => {
    const v = must(c.viewer);
    const b = await body<{ hash: string; accountId?: string; locale?: string }>(c);
    mustOpenFile(v, str(b.hash, "reference", 128));
    const accountId = b.accountId ?? pref(v, "account", accounts.firstFor(v.id) ?? "");
    accounts.owned(v.id, accountId);
    return { job: styles.learn(v, b.hash, accountId, b.locale) };
  });
  r.add("GET", "/api/styles/:id/thumbnail", (c) => {
    const v = must(c.viewer);
    if (!styles.canUse(v.id, c.params.id)) throw new HttpError(404, "That style doesn't exist.");
    const path = styles.thumbnailPath(c.params.id);
    if (!path) throw new HttpError(404, "That style has no thumbnail.");
    sendFile(c.req, c.res, path, "image/jpeg", "private, no-cache");
    return undefined;
  });
  r.add("PATCH", "/api/styles/:id", async (c) => styles.update(must(c.viewer), c.params.id, await body(c)));
  r.add("DELETE", "/api/styles/:id", (c) => (styles.remove(must(c.viewer), c.params.id), { ok: true }));
  r.add("PUT", "/api/styles/:id/shares", async (c) => styles.share(must(c.viewer), c.params.id, grantsOf(await body(c))));

  // ── Motion library ───────────────────────────────────────────

  const KINDS = new Set<MotionKind>(["animation", "caption", "thumbnail"]);
  r.add("GET", "/api/motion", (c) => {
    const v = must(c.viewer);
    const kind = c.query.get("kind") as MotionKind | null;
    if (kind && !KINDS.has(kind)) throw new HttpError(400, "kind is animation, caption or thumbnail.");
    const f = { kind: kind ?? undefined, operation: c.query.get("operation") ?? undefined, domain: c.query.get("domain") ?? undefined, technique: c.query.get("technique") ?? undefined, styleId: c.query.get("styleId") ?? undefined };
    return { items: motion.list(v.id, f), taxonomy: motion.taxonomy(v.id) };
  });
  for (const which of ["loop", "poster", "strip"] as const) {
    r.add("GET", `/api/motion/:id/${which}`, (c) => {
      sendFile(c.req, c.res, motion.file(must(c.viewer).id, c.params.id, which), which === "loop" ? "video/mp4" : "image/jpeg", "private, max-age=86400");
      return undefined;
    });
  }
  r.add("PATCH", "/api/motion/:id", async (c) => motion.rename(must(c.viewer), c.params.id, str((await body(c)).name, "name", 80)));
  r.add("DELETE", "/api/motion/:id", (c) => (motion.remove(must(c.viewer), c.params.id), { ok: true }));
  r.add("PUT", "/api/motion/:id/shares", async (c) => motion.share(must(c.viewer), c.params.id, grantsOf(await body(c))));
  r.add("POST", "/api/motion/terms/:id/approve", (c) => (motion.approveTerm(must(c.viewer), c.params.id), { ok: true }));
  r.add("POST", "/api/motion/terms/:id/merge", async (c) => (motion.mergeTerm(must(c.viewer), c.params.id, str((await body(c)).into, "into", 64)), { ok: true }));

  r.add("POST", "/api/recipes", async (c) => {
    const b = await body<{ title: string; text: string }>(c);
    return { id: styles.addRecipe(must(c.viewer).id, b.title, b.text) };
  });
  r.add("POST", "/api/recipes/:id/use", (c) => (styles.useRecipe(must(c.viewer).id, c.params.id), { ok: true }));
  r.add("DELETE", "/api/recipes/:id", (c) => (styles.removeRecipe(must(c.viewer), c.params.id), { ok: true }));

  // ── Memory ───────────────────────────────────────────────────

  r.add("POST", "/api/memory", async (c) => {
    const b = await body<{ text: string; area?: string; scope?: "personal" | "client" | "team"; clientId?: string | null }>(c);
    return memory.add(must(c.viewer), b);
  });
  r.add("PATCH", "/api/memory/:id", async (c) => memory.update(must(c.viewer), c.params.id, await body(c)));
  r.add("POST", "/api/memory/:id/confirm", async (c) => {
    const choice = (await body(c)).choice;
    if (choice !== "personal" && choice !== "client" && choice !== "dismiss") throw new HttpError(400, "Choose keep for me, keep for the client, or not now.");
    return { rule: memory.confirm(must(c.viewer), c.params.id, choice) };
  });
  r.add("DELETE", "/api/memory/:id", (c) => (memory.remove(must(c.viewer), c.params.id), { ok: true }));

  // ── Tools and packs ──────────────────────────────────────────

  r.add("POST", "/api/tools/:kind", async (c) => {
    const v = must(c.viewer);
    if (!TOOL_KINDS.has(c.params.kind)) throw new HttpError(404, "There is no such tool.");
    const b = await body<{ hash?: string }>(c);
    mustOpenFile(v, str(b.hash, "file", 128));
    return { job: jobs.add(`tool.${c.params.kind}`, b, { lane: c.params.kind === "transcribe" ? "light" : "heavy", priority: 4, owner: v.id }) };
  });
  r.add("GET", "/api/packs", (c) => (must(c.viewer), packs.list()));
  r.add("POST", "/api/packs/:id/install", (c) => {
    const v = must(c.viewer);
    if (team.mode === "hub") admin(v);
    else owner(v);
    return { job: packs.install(c.params.id as PackId) };
  });

  // ── Keys and integrations ────────────────────────────────────

  // Keys go in and are never sent back. The app only learns whether one exists.
  const keyName = (v: Viewer, name: string) => {
    if (name === "epidemic") return epidemicKeyFor(v.id, team.owner().id);
    if (name === "scrapecreators") return scrapeKeyFor(v.id);
    if (!STUDIO_KEYS.has(name)) throw new HttpError(404, "There is no such key.");
    if (team.mode === "hub") admin(v);
    else owner(v);
    return name;
  };
  r.add("POST", "/api/keys/:name", async (c) => {
    const v = must(c.viewer);
    const name = keyName(v, c.params.name);
    const value = str((await body(c)).value, "key", 4000).trim();
    // A Scrape Creators key is checked before it's saved, with the free balance call.
    if (c.params.name === "scrapecreators") await creditBalance(value);
    await secrets.set(name, value);
    if (STUDIO_KEYS.has(name)) team.audit(v, "key.set", "studio", null, null, { key: name });
    return { ok: true };
  });
  r.add("DELETE", "/api/keys/:name", async (c) => {
    const v = must(c.viewer);
    const name = keyName(v, c.params.name);
    await secrets.remove(name);
    if (c.params.name === "scrapecreators") db.setSetting(`m:${v.id}:scrapecreators`, "off");
    if (STUDIO_KEYS.has(name)) team.audit(v, "key.remove", "studio", null, null, { key: name });
    return { ok: true };
  });
  r.add("GET", "/api/integrations", async (c) => {
    const v = must(c.viewer);
    return {
      drive: await drive.status(), tailscale: await tailscaleStatus(), envato: { connected: db.setting(`m:${v.id}:envato`) === "on" },
      scrapecreators: { key: await secrets.has(scrapeKeyFor(v.id)), connected: db.setting(`m:${v.id}:scrapecreators`) === "on" },
    };
  });
  // Scrape Creators tools in chats are per person and need their key first.
  r.add("POST", "/api/integrations/scrapecreators", async (c) => {
    const v = must(c.viewer);
    const on = (await body(c)).on === true;
    if (on && !(await secrets.has(scrapeKeyFor(v.id)))) throw new HttpError(400, "Add your Scrape Creators API key in My account first.");
    db.setSetting(`m:${v.id}:scrapecreators`, on ? "on" : "off");
    return { connected: on };
  });
  r.add("GET", "/api/social/credits", async (c) => {
    const key = await secrets.get(scrapeKeyFor(must(c.viewer).id));
    if (!key) throw new HttpError(404, "No Scrape Creators key yet.");
    return { credits: await creditBalance(key) };
  });
  /**
   * A social video link becomes a stored file, like an upload. The link is checked before any
   * credit is spent, so an unsupported one is refused at once with the reason.
   */
  /**
   * Any pasted video link: a Google Drive file, downloaded directly, or a social post through the
   * person's Scrape Creators key. Either way it lands in the file store like an upload.
   */
  r.add("POST", "/api/links/fetch", async (c) => {
    const v = must(c.viewer);
    const link = str((await body(c)).url, "link", 2000);
    const drive = parseDriveLink(link);
    if (/drive\.google\.com|docs\.google\.com|drive\.usercontent\.google\.com/i.test(link) && !drive) throw new HttpError(422, "That Drive link doesn't point to a video file. Open the file and copy its share link.");
    if (drive?.kind === "folder") throw new HttpError(422, "That's a folder. Paste the link to one video file.");
    if (drive) {
      limits.check(`drive:${v.id}`, 30);
      const file = await downloadFile(files, drive.id, "", await secrets.get("google_api_key")).catch((e: Error) => {
        throw new HttpError(422, e.message.includes("isn't downloadable") || e.message.includes("refused") ? "Google Drive won't share that file. Set it to “Anyone with the link”, or upload the file." : e.message);
      });
      if (file.kind !== "video") throw new HttpError(422, `${file.name} isn't a video.`);
      library.grantFile(v.id, file.hash);
      return { file, platform: "Google Drive", credits: 0 };
    }
    platformOf(link);
    const key = await secrets.get(scrapeKeyFor(v.id));
    if (!key) throw new HttpError(400, "Add your Scrape Creators key in Settings → Account to use social links.");
    limits.check(`social:${v.id}`, 30);
    const r = await fetchSocialVideo(files, key, link);
    library.grantFile(v.id, r.file.hash);
    return r;
  });
  /** The videos in a shared Drive folder, so each can be fetched as its own raw clip. */
  r.add("POST", "/api/links/folder", async (c) => {
    must(c.viewer);
    const link = parseDriveLink(str((await body(c)).url, "link", 2000));
    if (link?.kind !== "folder") throw new HttpError(400, "That isn't a Google Drive folder link.");
    const videos = await folderVideos(link.id, await secrets.get("google_api_key")).catch((e: Error) => {
      throw new HttpError(422, e.message);
    });
    if (!videos.length) throw new HttpError(422, "That folder has no videos.");
    return { videos: videos.slice(0, 200).map((v) => ({ ...v, url: `https://drive.google.com/file/d/${v.id}/view` })) };
  });
  /** A script file as plain text. macOS's own textutil reads Word, RTF, ODT and HTML. */
  r.add("POST", "/api/text/extract", async (c) => {
    const v = must(c.viewer);
    const hash = str((await body(c)).hash, "file", 128);
    mustOpenFile(v, hash);
    const f = files.get(hash);
    if (!/\.(txt|md|srt|vtt|rtf|doc|docx|odt|html?)$/i.test(f.name)) throw new HttpError(400, "Use a .txt, .docx, .doc, .rtf, .odt or .md file.");
    const plain = /\.(txt|md|srt|vtt)$/i.test(f.name);
    const out = plain ? readFileSync(f.path, "utf8") : (await run("/usr/bin/textutil", ["-convert", "txt", "-stdout", f.path])).stdout;
    return { text: out.slice(0, 60_000) };
  });
  r.add("POST", "/api/social/fetch", async (c) => {
    const v = must(c.viewer);
    const link = str((await body(c)).url, "link", 2000);
    platformOf(link);
    const key = await secrets.get(scrapeKeyFor(v.id));
    if (!key) throw new HttpError(400, "Add your Scrape Creators API key in Settings → My account to use video links.");
    limits.check(`social:${v.id}`, 30);
    const r = await fetchSocialVideo(files, key, link);
    library.grantFile(v.id, r.file.hash);
    return r;
  });
  // Envato is per person. Turning it on checks Envato's server answers first, so a dead connection never reaches a chat.
  r.add("POST", "/api/integrations/envato", async (c) => {
    const v = must(c.viewer);
    const on = (await body(c)).on === true;
    if (on) await envatoReachable();
    db.setSetting(`m:${v.id}:envato`, on ? "on" : "off");
    return { connected: on };
  });
  r.add("POST", "/api/integrations/drive", async (c) => {
    const b = await body<{ key: string; sharedDriveId: string }>(c);
    return drive.connect(must(c.viewer), str(b.key, "key file", 20_000), str(b.sharedDriveId, "Shared Drive id", 200));
  });
  r.add("DELETE", "/api/integrations/drive", async (c) => (await drive.disconnect(must(c.viewer)), { ok: true }));
  r.add("POST", "/api/integrations/tailscale/serve", async (c) => {
    const v = owner(must(c.viewer));
    if (v.via !== "local") throw new HttpError(403, "Change this from the Mac app on the Hub itself.");
    const on = (await body(c)).on === true;
    const status = await tailscaleServe(on);
    team.audit(v, on ? "tailscale.serve.on" : "tailscale.serve.off", "studio", null, null, null);
    return status;
  });

  r.add("POST", "/api/settings", async (c) => {
    const v = must(c.viewer);
    const b = await body<Record<string, string>>(c);
    if (b.account !== undefined) {
      accounts.owned(v.id, b.account);
      db.setSetting(`m:${v.id}:account`, b.account);
    }
    if (b.usage_ceiling !== undefined) {
      const n = Number(b.usage_ceiling);
      if (!(n >= 10 && n <= 100)) throw new HttpError(400, "Pick a number from 10 to 100.");
      db.setSetting(`m:${v.id}:usage_ceiling`, String(n));
    }
    for (const key of ["max_card_batch", "embed_model"]) {
      if (b[key] === undefined) continue;
      if (team.mode === "hub") admin(v);
      else owner(v);
      db.setSetting(key, String(b[key]).slice(0, 200));
    }
    return { ok: true };
  });
  return r;
}

function grantsOf(b: Record<string, unknown>): Grant[] {
  const list = b.grants;
  if (!Array.isArray(list)) throw new HttpError(400, "Send the list of people to share with.");
  if (list.length > 200) throw new HttpError(400, "That's too many people.");
  return list.map((g) => {
    const x = g as Partial<Grant>;
    if (typeof x.grantee !== "string" || !["use", "add", "edit"].includes(String(x.permission))) throw new HttpError(400, "Each share needs a person and a permission.");
    return { grantee: x.grantee, permission: x.permission! };
  });
}

const SIGN_IN = `<!doctype html><meta charset="utf-8"><title>Shifu Dojo</title><body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><p>Open Shifu Dojo from the Mac app.</p></body>`;

/** Routes anyone may call. Everything else needs a signed-in person. */
const PUBLIC = /^\/api\/auth\//;

function securityHeaders(res: ServerResponse, secure: boolean) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  // Only rules that can't break the studio: no embedding in other sites, no plugins, no base-tag tricks.
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

export function handler(router: Router, token: string, team: Team) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "";
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    try {
      // A Host check stops DNS rebinding. Only loopback and the Hub's own address are answered.
      if (!team.hosts().has(host)) {
        res.writeHead(421, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not allowed." }));
        return;
      }
      securityHeaders(res, isSecure(team, host));
      // One link from the Mac app or terminal becomes a same-site cookie, then the token leaves the address bar.
      const key = url.searchParams.get("k");
      if (key && !url.pathname.startsWith("/api/") && LOOPBACK.has(host) && same(key, token)) {
        res.writeHead(302, { "Set-Cookie": `${LOCAL_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: "/" }).end();
        return;
      }
      const { viewer, via } = identify(req, token, team);
      if (via === "cookie" && !sameOrigin(req, team)) {
        res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not allowed." }));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (!viewer && !PUBLIC.test(url.pathname)) {
          res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: team.mode === "hub" ? "Sign in first." : "Open Shifu Dojo from the Mac app." }));
          return;
        }
        // Public sign-in routes must also come from this site, since they set cookies.
        if (PUBLIC.test(url.pathname) && !sameOrigin(req, team)) {
          res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not allowed." }));
          return;
        }
        const hit = router.match(req.method ?? "GET", url.pathname);
        if (!hit) throw new HttpError(404, "Not found.");
        let parsed: Promise<Record<string, unknown>> | null = null;
        const out = await hit.handler({ req, res, params: hit.params, query: url.searchParams, viewer: viewer ?? undefined, body: () => (parsed ??= readJson(req)) });
        if (out !== undefined && !res.headersSent) res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(out));
        return;
      }
      // A single-user studio only opens from the Mac app. A Hub serves its page to anyone, who then signs in.
      if (!viewer && team.mode !== "hub") {
        res.writeHead(401, { "Content-Type": "text/html" }).end(SIGN_IN);
        return;
      }
      const root = resolve(WEB_DIR);
      const wanted = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      const file = wanted.startsWith(root + sep) && existsSync(wanted) && statSync(wanted).isFile() ? wanted : join(root, "index.html");
      if (!existsSync(file)) return void res.writeHead(404).end("Build the web app first: npm run build");
      sendFile(req, res, file, typeFor(file), file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    } catch (e) {
      const error = e as Error;
      const status = e instanceof HttpError ? e.status : 400;
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
      else res.destroy();
    }
  };
}
