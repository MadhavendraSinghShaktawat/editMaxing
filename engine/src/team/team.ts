import { createHash, randomBytes, randomUUID } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Bus } from "../bus.ts";
import { PORT } from "../config.ts";
import type { Database } from "../db.ts";
import { json } from "../db.ts";
import { HttpError } from "../lib/http.ts";

export type Role = "owner" | "admin" | "editor";
export type StudioMode = "single" | "hub" | "joined";
/** The person behind a request. "local" means the Mac app on this machine, which is always the Owner. */
export type Viewer = { id: string; name: string; role: Role; via: "local" | "session"; sessionId?: string };

export type MemberRow = { id: string; name: string; role: Role; status: "active" | "removed" | "archived"; webauthn_id: string; created_at: number; last_seen_at: number | null; ended_at: number | null };
type SessionRow = { id: string; member_id: string; device: string | null; created_at: number; last_seen_at: number; expires_at: number; revoked_at: number | null };
type InviteRow = { id: string; name: string; role: "admin" | "editor"; created_by: string; created_at: number; expires_at: number; used_at: number | null; used_by: string | null; revoked_at: number | null };
type PasskeyRow = { id: string; member_id: string; public_key: Uint8Array; counter: number; transports: string | null; rp_id: string; label: string | null; created_at: number; last_used_at: number | null };

/** Where a passkey ceremony happens. Passkeys are bound to the site's name, so this decides which ones work. */
export type Site = { rpID: string; origin: string };

const DAY = 86_400_000;
export const SESSION_DAYS = 30;
export const INVITE_DAYS = 7;
export const CLOSING_DAYS = 14;
const CHALLENGE_MS = 5 * 60_000;
const NAME = "Shifu Dojo";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
export const isAdmin = (v: Pick<Viewer, "role">) => v.role === "owner" || v.role === "admin";

/**
 * A Hub address is the site teammates open. Only https, or plain http on localhost for testing,
 * because browsers refuse passkeys anywhere else. No path, so cookies and passkeys stay on one origin.
 */
export function parseHubOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(400, "That isn't a web address. Use something like https://studio.socialshifu.com");
  }
  const local = url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new HttpError(400, "The Hub address must start with https://");
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new HttpError(400, "Use only the address, with nothing after the domain.");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(":")) throw new HttpError(400, "Passkeys need a name like studio.socialshifu.com, not an IP address.");
  return { origin: url.origin, host: url.host, hostname: url.hostname };
}

export class Team {
  private db: Database;
  private bus: Bus;
  private challenges = new Map<string, { challenge: string; purpose: "join" | "add" | "login"; memberId?: string; inviteId?: string; site: Site; expires: number }>();
  /** Lets the rest of the engine react when someone loses access, such as closing their running chats. */
  onRemoved: (memberId: string) => void = () => {};

  constructor(db: Database, bus: Bus) {
    this.db = db;
    this.bus = bus;
  }

  // ── Studio mode ──────────────────────────────────────────────

  get mode(): StudioMode {
    const m = this.db.setting("studio_mode");
    return m === "hub" || m === "joined" ? m : "single";
  }

  get hubOrigin() {
    return this.db.setting("hub_origin");
  }

  get joinedHub() {
    return this.db.setting("joined_hub");
  }

  /** When an Owner turns the Hub off while others are still in it, this is when their access ends. */
  get closingAt() {
    const v = Number(this.db.setting("hub_closing_at") ?? 0);
    return v > 0 ? v : null;
  }

  owner() {
    const o = this.db.get<MemberRow>("SELECT * FROM members WHERE role = 'owner'");
    if (!o) throw new Error("This studio has no Owner. The database may be damaged.");
    return o;
  }

  ownerViewer(): Viewer {
    const o = this.owner();
    return { id: o.id, name: o.name, role: "owner", via: "local" };
  }

  /** Hosts this engine answers to. Loopback always, plus the Hub's own address once one is set. */
  hosts() {
    const out = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
    if (this.mode === "hub" && this.hubOrigin) out.add(parseHubOrigin(this.hubOrigin).host);
    return out;
  }

  origins() {
    const out = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
    if (this.mode === "hub" && this.hubOrigin) out.add(this.hubOrigin);
    return out;
  }

  /** Picks the passkey site for a request. 127.0.0.1 can't hold passkeys, so local testing uses localhost. */
  siteFor(host: string): Site {
    if (this.mode === "hub" && this.hubOrigin) {
      const hub = parseHubOrigin(this.hubOrigin);
      if (host === hub.host) return { rpID: hub.hostname, origin: hub.origin };
    }
    if (host === `localhost:${PORT}`) return { rpID: "localhost", origin: `http://localhost:${PORT}` };
    throw new HttpError(400, `Passkeys need the Hub's address. Open ${this.hubOrigin ?? `http://localhost:${PORT}`} instead.`);
  }

  setMode(actor: Viewer, mode: StudioMode, options: { hubOrigin?: string | null; joinedHub?: string | null } = {}) {
    if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can change the studio mode.");
    if (actor.via !== "local") throw new HttpError(403, "Change the studio mode from the Mac app on the Hub itself.");
    const current = this.mode;
    if (options.hubOrigin !== undefined) this.setHubOrigin(actor, options.hubOrigin);
    if (mode === "joined") {
      if (!options.joinedHub && !this.joinedHub) throw new HttpError(400, "Add the Hub's address first.");
      if (options.joinedHub) this.db.setSetting("joined_hub", parseHubOrigin(options.joinedHub).origin);
    }
    if (current === mode) return this.status();
    if (current === "hub" && this.others().length) {
      throw new HttpError(409, "Other people are still in this Hub. Use “Close the Hub” so they get 14 days to export their work first.");
    }
    this.db.setSetting("studio_mode", mode);
    this.audit(actor, "studio.mode", "studio", null, null, { from: current, to: mode });
    this.changed();
    return this.status();
  }

  setHubOrigin(actor: Viewer, value: string | null) {
    if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can change the Hub's address.");
    const before = this.hubOrigin;
    const next = value?.trim() ? parseHubOrigin(value).origin : null;
    if (next === before) return;
    if (next) this.db.setSetting("hub_origin", next);
    else this.db.run("DELETE FROM settings WHERE key = 'hub_origin'");
    // Passkeys belong to one site name. Moving the Hub means everyone signs in again from a new invite.
    if (before) this.audit(actor, "hub.address", "studio", null, null, { from: before, to: next });
    this.changed();
  }

  /** Starts the 14-day wind-down. Members keep access so they can export, then their data is archived. */
  startClosing(actor: Viewer) {
    if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can close the Hub.");
    if (this.mode !== "hub") throw new HttpError(400, "This Mac isn't a Studio Hub.");
    if (!this.others().length) return this.setMode(actor, "single");
    const at = Date.now() + CLOSING_DAYS * DAY;
    this.db.setSetting("hub_closing_at", String(at));
    this.audit(actor, "hub.closing", "studio", null, null, { at });
    this.changed("*");
    return this.status();
  }

  cancelClosing(actor: Viewer) {
    if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can do that.");
    this.db.run("DELETE FROM settings WHERE key = 'hub_closing_at'");
    this.audit(actor, "hub.closing.cancelled", "studio", null, null, null);
    this.changed("*");
    return this.status();
  }

  /** Runs on a timer. Archiving keeps every row; it only ends access. Deleting is a separate, deliberate step. */
  tick(now = Date.now()) {
    const at = this.closingAt;
    if (at && now >= at) {
      for (const m of this.others()) this.end(m.id, "archived");
      this.db.run("DELETE FROM settings WHERE key = 'hub_closing_at'");
      this.db.setSetting("studio_mode", "single");
      this.audit(null, "hub.closed", "studio", null, null, null);
      this.changed("*");
    }
    this.db.run("DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)", now - DAY, now - 30 * DAY);
    for (const [id, c] of this.challenges) if (c.expires < now) this.challenges.delete(id);
  }

  status() {
    return { mode: this.mode, hubOrigin: this.hubOrigin, joinedHub: this.joinedHub, closingAt: this.closingAt };
  }

  // ── Members ──────────────────────────────────────────────────

  member(id: string) {
    const m = this.db.get<MemberRow>("SELECT * FROM members WHERE id = ?", id);
    if (!m) throw new HttpError(404, "That person isn't in this studio.");
    return m;
  }

  private others() {
    return this.db.all<MemberRow>("SELECT * FROM members WHERE role != 'owner' AND status = 'active'");
  }

  activeIds() {
    return this.db.all<{ id: string }>("SELECT id FROM members WHERE status = 'active'").map((r) => r.id);
  }

  members() {
    return this.db.all<MemberRow & { passkeys: number; devices: number }>(
      `SELECT m.*, (SELECT COUNT(*) FROM passkeys p WHERE p.member_id = m.id) passkeys,
        (SELECT COUNT(*) FROM sessions s WHERE s.member_id = m.id AND s.revoked_at IS NULL AND s.expires_at > ?) devices
       FROM members m ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at`,
      Date.now(),
    ).map((m) => ({ id: m.id, name: m.name, role: m.role, status: m.status, createdAt: m.created_at, lastSeenAt: m.last_seen_at, endedAt: m.ended_at, passkeys: m.passkeys, devices: m.devices }));
  }

  rename(actor: Viewer, id: string, name: string) {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new HttpError(400, "Add a name.");
    if (actor.id !== id && !isAdmin(actor)) throw new HttpError(403, "You can only change your own name.");
    this.member(id);
    this.db.run("UPDATE members SET name = ? WHERE id = ?", clean, id);
    if (actor.id !== id) this.audit(actor, "member.rename", "member", id, id, { name: clean });
    this.changed();
  }

  /** Only the Owner hands out admin rights, so an admin can't promote themselves or anyone else. */
  setRole(actor: Viewer, id: string, role: Role) {
    if (actor.role !== "owner") throw new HttpError(403, "Only the Owner can change roles.");
    if (role !== "admin" && role !== "editor") throw new HttpError(400, "A role is Admin or Editor.");
    const m = this.member(id);
    if (m.role === "owner") throw new HttpError(400, "The Owner's role can't change.");
    if (m.status !== "active") throw new HttpError(400, `${m.name} is no longer in the studio.`);
    this.db.run("UPDATE members SET role = ? WHERE id = ?", role, id);
    this.audit(actor, "member.role", "member", id, id, { from: m.role, to: role });
    this.changed();
  }

  remove(actor: Viewer, id: string) {
    if (!isAdmin(actor)) throw new HttpError(403, "Only admins can remove people.");
    const m = this.member(id);
    if (m.role === "owner") throw new HttpError(400, "The Owner can't be removed.");
    if (m.role === "admin" && actor.role !== "owner") throw new HttpError(403, "Only the Owner can remove an admin.");
    if (m.id === actor.id) throw new HttpError(400, "You can't remove yourself.");
    this.end(id, "removed");
    this.audit(actor, "member.remove", "member", id, id, { name: m.name });
    this.changed();
  }

  /** Ends someone's access everywhere at once. Their work stays, so admins can still see or remove it. */
  private end(id: string, status: "removed" | "archived") {
    this.db.tx(() => {
      this.db.run("UPDATE members SET status = ?, ended_at = ? WHERE id = ?", status, Date.now(), id);
      this.db.run("UPDATE sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL", Date.now(), id);
      this.db.run("DELETE FROM passkeys WHERE member_id = ?", id);
      this.db.run("DELETE FROM client_members WHERE member_id = ?", id);
      this.db.run("DELETE FROM shares WHERE grantee = ?", id);
    });
    this.bus.drop(id);
    this.onRemoved(id);
  }

  // ── Invites ──────────────────────────────────────────────────

  invite(actor: Viewer, name: string, role: "admin" | "editor") {
    if (this.mode !== "hub") throw new HttpError(400, "Turn this Mac into a Studio Hub first.");
    if (!isAdmin(actor)) throw new HttpError(403, "Only admins can invite people.");
    if (role === "admin" && actor.role !== "owner") throw new HttpError(403, "Only the Owner can invite an admin.");
    if (role !== "admin" && role !== "editor") throw new HttpError(400, "A role is Admin or Editor.");
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new HttpError(400, "Add the person's name.");
    if (!this.hubOrigin) throw new HttpError(400, "Add the Hub's web address first, so the invite link has somewhere to go.");
    const token = newToken();
    const id = randomUUID();
    const now = Date.now();
    this.db.run("INSERT INTO invites (id, token_hash, name, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, hashToken(token), clean, role, actor.id, now, now + INVITE_DAYS * DAY);
    this.audit(actor, "invite.create", "invite", id, null, { name: clean, role });
    this.changed();
    // The token sits after # so it never reaches a server log or a proxy. It's shown once and only its hash is kept.
    return { id, name: clean, role, expiresAt: now + INVITE_DAYS * DAY, link: `${this.hubOrigin}/#join=${token}` };
  }

  invites() {
    return this.db.all<InviteRow>("SELECT * FROM invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC", Date.now()).map((i) => ({ id: i.id, name: i.name, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at }));
  }

  revokeInvite(actor: Viewer, id: string) {
    if (!isAdmin(actor)) throw new HttpError(403, "Only admins can cancel invites.");
    this.db.run("UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL", Date.now(), id);
    this.audit(actor, "invite.revoke", "invite", id, null, null);
    this.changed();
  }

  private openInvite(token: string) {
    const i = this.db.get<InviteRow>("SELECT * FROM invites WHERE token_hash = ?", hashToken(token));
    if (!i || i.revoked_at) throw new HttpError(404, "This invite isn't valid. Ask your admin for a new one.");
    if (i.used_at) throw new HttpError(410, "This invite was already used. Ask your admin for a new one.");
    if (i.expires_at < Date.now()) throw new HttpError(410, "This invite has expired. Ask your admin for a new one.");
    if (this.mode !== "hub") throw new HttpError(410, "This studio isn't accepting new people right now.");
    return i;
  }

  inviteInfo(token: string) {
    const i = this.openInvite(token);
    return { name: i.name, role: i.role, studio: this.owner().name === "You" ? NAME : `${this.owner().name}'s studio` };
  }

  // ── Passkeys ─────────────────────────────────────────────────

  private remember(c: { challenge: string; purpose: "join" | "add" | "login"; memberId?: string; inviteId?: string; site: Site }) {
    const id = randomUUID();
    this.challenges.set(id, { ...c, expires: Date.now() + CHALLENGE_MS });
    return id;
  }

  private takeChallenge(id: string, purpose: "join" | "add" | "login") {
    const c = this.challenges.get(id);
    this.challenges.delete(id);
    if (!c || c.purpose !== purpose || c.expires < Date.now()) throw new HttpError(400, "That took too long. Try again.");
    return c;
  }

  /** Step one of joining: the invite becomes a pending member only when the passkey is verified. */
  async joinOptions(token: string, site: Site) {
    const i = this.openInvite(token);
    const userID = randomBytes(32);
    const options = await generateRegistrationOptions({
      rpName: NAME, rpID: site.rpID, userName: i.name, userDisplayName: i.name, userID,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const ticket = this.remember({ challenge: options.challenge, purpose: "join", inviteId: i.id, site });
    this.pendingUserIds.set(ticket, Buffer.from(userID).toString("base64url"));
    return { ticket, options };
  }

  private pendingUserIds = new Map<string, string>();

  async join(token: string, ticket: string, response: RegistrationResponseJSON, device: string | null) {
    const c = this.takeChallenge(ticket, "join");
    const webauthnId = this.pendingUserIds.get(ticket);
    this.pendingUserIds.delete(ticket);
    const i = this.openInvite(token);
    if (i.id !== c.inviteId || !webauthnId) throw new HttpError(400, "That passkey was made for a different invite.");
    const v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: c.site.origin, expectedRPID: c.site.rpID, requireUserVerification: true });
    if (!v.verified) throw new HttpError(400, "That passkey couldn't be verified.");
    const memberId = randomUUID();
    const now = Date.now();
    this.db.tx(() => {
      // Claiming the invite and creating the member is one step, so an invite can never make two people.
      const claimed = this.db.run("UPDATE invites SET used_at = ?, used_by = NULL WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL", now, i.id);
      if (!claimed.changes) throw new HttpError(410, "This invite was already used.");
      this.db.run("INSERT INTO members (id, name, role, webauthn_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)", memberId, i.name, i.role, webauthnId, now, now);
      this.db.run("UPDATE invites SET used_by = ? WHERE id = ?", memberId, i.id);
      this.savePasskey(memberId, v.registrationInfo, c.site, device);
      this.db.run("INSERT INTO libraries (id, owner_id, name, created_at) VALUES (?, ?, 'My B-roll', ?)", randomUUID(), memberId, now);
    });
    this.audit({ id: memberId }, "member.join", "member", memberId, memberId, { invite: i.id, role: i.role });
    this.changed();
    return this.createSession(memberId, device);
  }

  private savePasskey(memberId: string, info: Awaited<ReturnType<typeof verifyRegistrationResponse>>["registrationInfo"] & object, site: Site, device: string | null) {
    const { credential } = info;
    this.db.run(
      "INSERT INTO passkeys (id, member_id, public_key, counter, transports, device_type, backed_up, rp_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      credential.id, memberId, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, site.rpID, device?.slice(0, 80) ?? null, Date.now(),
    );
  }

  /** A signed-in member can add a second passkey, such as their phone, so losing one device doesn't lock them out. */
  async addOptions(viewer: Viewer, site: Site) {
    const m = this.member(viewer.id);
    const existing = this.db.all<PasskeyRow>("SELECT * FROM passkeys WHERE member_id = ? AND rp_id = ?", m.id, site.rpID);
    const options = await generateRegistrationOptions({
      rpName: NAME, rpID: site.rpID, userName: m.name, userDisplayName: m.name, userID: Buffer.from(m.webauthn_id, "base64url"),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: json<string[]>(p.transports, []) })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return { ticket: this.remember({ challenge: options.challenge, purpose: "add", memberId: m.id, site }), options };
  }

  async addPasskey(viewer: Viewer, ticket: string, response: RegistrationResponseJSON, device: string | null) {
    const c = this.takeChallenge(ticket, "add");
    if (c.memberId !== viewer.id) throw new HttpError(400, "That passkey request belongs to someone else.");
    const v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: c.site.origin, expectedRPID: c.site.rpID, requireUserVerification: true });
    if (!v.verified) throw new HttpError(400, "That passkey couldn't be verified.");
    this.savePasskey(viewer.id, v.registrationInfo, c.site, device);
    this.audit(viewer, "passkey.add", "member", viewer.id, viewer.id, null);
    return { ok: true };
  }

  passkeys(memberId: string) {
    return this.db.all<PasskeyRow>("SELECT * FROM passkeys WHERE member_id = ? ORDER BY created_at", memberId).map((p) => ({ id: p.id, label: p.label, site: p.rp_id, createdAt: p.created_at, lastUsedAt: p.last_used_at }));
  }

  removePasskey(viewer: Viewer, id: string) {
    const p = this.db.get<PasskeyRow>("SELECT * FROM passkeys WHERE id = ?", id);
    if (!p || p.member_id !== viewer.id) throw new HttpError(404, "That passkey isn't yours.");
    const count = this.db.get<{ n: number }>("SELECT COUNT(*) n FROM passkeys WHERE member_id = ?", viewer.id)!.n;
    if (count <= 1 && viewer.role !== "owner") throw new HttpError(400, "This is your only passkey. Add another one first, or you'll be locked out.");
    this.db.run("DELETE FROM passkeys WHERE id = ?", id);
    this.audit(viewer, "passkey.remove", "member", viewer.id, viewer.id, null);
  }

  /** Sign-in uses discoverable passkeys, so nobody types a name or email. */
  async loginOptions(site: Site) {
    const options = await generateAuthenticationOptions({ rpID: site.rpID, userVerification: "required" });
    return { ticket: this.remember({ challenge: options.challenge, purpose: "login", site }), options };
  }

  async login(ticket: string, response: AuthenticationResponseJSON, device: string | null) {
    const c = this.takeChallenge(ticket, "login");
    const p = this.db.get<PasskeyRow>("SELECT * FROM passkeys WHERE id = ? AND rp_id = ?", response.id, c.site.rpID);
    if (!p) throw new HttpError(401, "This passkey isn't registered here. Ask your admin for an invite.");
    const m = this.member(p.member_id);
    if (m.status !== "active") throw new HttpError(403, "Your access to this studio has ended.");
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: c.challenge, expectedOrigin: c.site.origin, expectedRPID: c.site.rpID, requireUserVerification: true,
      credential: { id: p.id, publicKey: new Uint8Array(p.public_key), counter: p.counter, transports: json(p.transports, []) },
    });
    if (!v.verified) throw new HttpError(401, "That passkey couldn't be verified.");
    this.db.run("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?", v.authenticationInfo.newCounter, Date.now(), p.id);
    return this.createSession(m.id, device);
  }

  // ── Sessions ─────────────────────────────────────────────────

  private createSession(memberId: string, device: string | null) {
    const token = newToken();
    const now = Date.now();
    const id = randomUUID();
    this.db.run("INSERT INTO sessions (id, token_hash, member_id, device, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, hashToken(token), memberId, device?.slice(0, 120) ?? null, now, now, now + SESSION_DAYS * DAY);
    this.db.run("UPDATE members SET last_seen_at = ? WHERE id = ?", now, memberId);
    return { token, sessionId: id, maxAge: SESSION_DAYS * 86_400 };
  }

  /** Sliding expiry, written at most once an hour so busy pages don't hammer the database. */
  viewerFor(token: string): Viewer | null {
    if (this.mode !== "hub") return null;
    const s = this.db.get<SessionRow & { token_hash: string }>("SELECT * FROM sessions WHERE token_hash = ?", hashToken(token));
    const now = Date.now();
    if (!s || s.revoked_at || s.expires_at < now) return null;
    const m = this.db.get<MemberRow>("SELECT * FROM members WHERE id = ?", s.member_id);
    if (!m || m.status !== "active") return null;
    if (now - s.last_seen_at > 3_600_000) {
      this.db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", now, now + SESSION_DAYS * DAY, s.id);
      this.db.run("UPDATE members SET last_seen_at = ? WHERE id = ?", now, m.id);
    }
    return { id: m.id, name: m.name, role: m.role, via: "session", sessionId: s.id };
  }

  sessions(memberId: string) {
    return this.db.all<SessionRow>("SELECT * FROM sessions WHERE member_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC", memberId, Date.now()).map((s) => ({ id: s.id, device: s.device, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at }));
  }

  revokeSession(actor: Viewer, id: string) {
    const s = this.db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
    if (!s) throw new HttpError(404, "That device isn't signed in.");
    if (s.member_id !== actor.id && !isAdmin(actor)) throw new HttpError(403, "You can only sign out your own devices.");
    this.db.run("UPDATE sessions SET revoked_at = ? WHERE id = ?", Date.now(), id);
    if (s.member_id !== actor.id) this.audit(actor, "session.revoke", "member", s.member_id, s.member_id, { device: s.device });
  }

  logout(viewer: Viewer) {
    if (viewer.sessionId) this.db.run("UPDATE sessions SET revoked_at = ? WHERE id = ?", Date.now(), viewer.sessionId);
  }

  // ── Clients ──────────────────────────────────────────────────

  clients(viewer: Viewer) {
    const rows = isAdmin(viewer)
      ? this.db.all<{ id: string; name: string; created_at: number }>("SELECT * FROM clients WHERE archived_at IS NULL ORDER BY name")
      : this.db.all<{ id: string; name: string; created_at: number }>("SELECT c.* FROM clients c JOIN client_members cm ON cm.client_id = c.id WHERE cm.member_id = ? AND c.archived_at IS NULL ORDER BY c.name", viewer.id);
    return rows.map((c) => ({ id: c.id, name: c.name, members: this.db.all<{ member_id: string }>("SELECT member_id FROM client_members WHERE client_id = ?", c.id).map((r) => r.member_id) }));
  }

  onClient(memberId: string, clientId: string) {
    return !!this.db.get("SELECT 1 FROM client_members WHERE client_id = ? AND member_id = ?", clientId, memberId);
  }

  clientIdsFor(memberId: string) {
    return this.db.all<{ client_id: string }>("SELECT client_id FROM client_members WHERE member_id = ?", memberId).map((r) => r.client_id);
  }

  createClient(actor: Viewer, name: string) {
    if (!isAdmin(actor)) throw new HttpError(403, "Only admins can add clients.");
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new HttpError(400, "Add the client's name.");
    const id = randomUUID();
    this.db.run("INSERT INTO clients (id, name, created_by, created_at) VALUES (?, ?, ?, ?)", id, clean, actor.id, Date.now());
    this.audit(actor, "client.create", "client", id, null, { name: clean });
    this.changed();
    return { id, name: clean, members: [] as string[] };
  }

  updateClient(actor: Viewer, id: string, patch: { name?: string; members?: string[] }) {
    if (!isAdmin(actor)) throw new HttpError(403, "Only admins can change clients.");
    if (!this.db.get("SELECT 1 FROM clients WHERE id = ? AND archived_at IS NULL", id)) throw new HttpError(404, "That client doesn't exist.");
    this.db.tx(() => {
      if (patch.name?.trim()) this.db.run("UPDATE clients SET name = ? WHERE id = ?", patch.name.trim().slice(0, 80), id);
      if (patch.members) {
        const active = new Set(this.activeIds());
        this.db.run("DELETE FROM client_members WHERE client_id = ?", id);
        for (const m of new Set(patch.members)) {
          if (!active.has(m)) throw new HttpError(400, "One of those people isn't in the studio.");
          this.db.run("INSERT INTO client_members (client_id, member_id) VALUES (?, ?)", id, m);
        }
      }
    });
    this.audit(actor, "client.update", "client", id, null, patch);
    this.changed();
  }

  archiveClient(actor: Viewer, id: string) {
    if (!isAdmin(actor)) throw new HttpError(403, "Only admins can remove clients.");
    this.db.run("UPDATE clients SET archived_at = ? WHERE id = ?", Date.now(), id);
    this.audit(actor, "client.archive", "client", id, null, null);
    this.changed();
  }

  // ── Activity log ─────────────────────────────────────────────

  audit(actor: Pick<Viewer, "id"> | null, action: string, targetType: string | null, targetId: string | null, targetOwner: string | null, detail: unknown) {
    this.db.run("INSERT INTO audit_log (actor_id, action, target_type, target_id, target_owner, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", actor?.id ?? null, action, targetType, targetId, targetOwner, detail == null ? null : JSON.stringify(detail), Date.now());
  }

  log(limit = 200, before?: number) {
    return this.db.all<{ id: number; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; target_owner: string | null; detail: string | null; created_at: number }>(
      "SELECT * FROM audit_log WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?", before ?? null, before ?? null, Math.min(500, limit),
    ).map((r) => ({ id: r.id, actorId: r.actor_id, action: r.action, targetType: r.target_type, targetId: r.target_id, targetOwner: r.target_owner, detail: json(r.detail, null), at: r.created_at }));
  }

  private changed(to: "admins" | "*" = "admins") {
    this.bus.emit("team", this.status(), to);
  }
}
