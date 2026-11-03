import type { Database } from "../db.ts";
import { HttpError } from "../lib/http.ts";
import type { Team, Viewer } from "./team.ts";

export type ShareType = "library" | "style" | "motion";
export type Permission = "use" | "add" | "edit";
export type Grant = { grantee: string; permission: Permission };
/** What a person may do with something. "own" covers changing who it's shared with and deleting it. */
export type Need = "use" | "add" | "edit" | "own";

const ALLOWED: Record<ShareType, Permission[]> = { library: ["use", "add"], style: ["use", "edit"], motion: ["use", "edit"] };
const TABLE: Record<ShareType, string> = { library: "libraries", style: "styles", motion: "motion_items" };
const NOUN: Record<ShareType, string> = { library: "library", style: "style", motion: "saved animation" };
const RANK: Record<Permission, number> = { use: 1, add: 2, edit: 2 };
const NEEDS: Record<Need, number> = { use: 1, add: 2, edit: 2, own: 3 };

/**
 * Sharing for libraries, styles and Motion library items. Private by default. An owner shares with chosen
 * colleagues or the whole team, and only an owner changes who has access.
 * Admins see everything, but only through Settings → Users, never mixed into their own work.
 */
export class Access {
  private db: Database;
  private team: Team;

  constructor(db: Database, team: Team) {
    this.db = db;
    this.team = team;
  }

  ownerOf(type: ShareType, id: string) {
    const row = this.db.get<{ owner_id: string | null }>(`SELECT owner_id FROM ${TABLE[type]} WHERE id = ?`, id);
    if (!row) throw new HttpError(404, `That ${NOUN[type]} doesn't exist.`);
    return row.owner_id;
  }

  /** The strongest permission someone has been given, directly or through a team-wide share. */
  granted(type: ShareType, id: string, memberId: string): Permission | null {
    const rows = this.db.all<{ permission: Permission }>("SELECT permission FROM shares WHERE resource_type = ? AND resource_id = ? AND grantee IN (?, 'team')", type, id, memberId);
    return rows.reduce<Permission | null>((best, r) => (!best || RANK[r.permission] > RANK[best] ? r.permission : best), null);
  }

  can(viewer: Viewer, type: ShareType, id: string, need: Need) {
    const owner = this.ownerOf(type, id);
    // Styles from the repo have no owner. Everyone may use them and nobody may change them here.
    if (owner === null) return need === "use";
    if (owner === viewer.id) return true;
    if (need === "own") return false;
    const p = this.granted(type, id, viewer.id);
    return !!p && RANK[p] >= NEEDS[need];
  }

  require(viewer: Viewer, type: ShareType, id: string, need: Need) {
    if (!this.can(viewer, type, id, need)) {
      throw new HttpError(this.can(viewer, type, id, "use") ? 403 : 404, need === "own" ? "Only its owner can do that." : `You don't have access to that ${NOUN[type]}.`);
    }
  }

  /** Ids of everything this person can use: their own, plus what's shared with them or the team. */
  visible(type: ShareType, viewer: Viewer) {
    const table = TABLE[type];
    const live = type === "library" ? "AND removed_at IS NULL" : "";
    return this.db.all<{ id: string }>(
      `SELECT id FROM ${table} WHERE (owner_id = ? ${type === "style" ? "OR owner_id IS NULL" : ""}
         OR id IN (SELECT resource_id FROM shares WHERE resource_type = ? AND grantee IN (?, 'team'))) ${live}`,
      viewer.id, type, viewer.id,
    ).map((r) => r.id);
  }

  grants(type: ShareType, id: string): Grant[] {
    return this.db.all<Grant>("SELECT grantee, permission FROM shares WHERE resource_type = ? AND resource_id = ? ORDER BY grantee", type, id);
  }

  /** Replaces the whole share list at once, so the UI shows exactly what's stored. */
  setGrants(viewer: Viewer, type: ShareType, id: string, grants: Grant[]) {
    this.require(viewer, type, id, "own");
    const active = new Set(this.team.activeIds());
    const seen = new Set<string>();
    for (const g of grants) {
      if (!ALLOWED[type].includes(g.permission)) throw new HttpError(400, `A ${type} can be shared as ${ALLOWED[type].join(" or ")}.`);
      if (g.grantee !== "team" && !active.has(g.grantee)) throw new HttpError(400, "One of those people isn't in the studio.");
      if (g.grantee === viewer.id) throw new HttpError(400, "You already own this.");
      if (seen.has(g.grantee)) throw new HttpError(400, "Each person can appear once.");
      seen.add(g.grantee);
    }
    if (grants.length && this.team.mode !== "hub") throw new HttpError(400, "Sharing needs a Studio Hub. Turn it on in Settings → Studio mode.");
    const before = this.grants(type, id);
    this.db.tx(() => {
      this.db.run("DELETE FROM shares WHERE resource_type = ? AND resource_id = ?", type, id);
      for (const g of grants) this.db.run("INSERT INTO shares (resource_type, resource_id, grantee, permission, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", type, id, g.grantee, g.permission, viewer.id, Date.now());
    });
    this.team.audit(viewer, `${type}.share`, type, id, viewer.id, { before, after: grants });
    return { wasShared: before.length > 0, isShared: grants.length > 0 };
  }

  /** Records a change someone made to another person's things. */
  audit(viewer: Viewer, action: string, targetId: string, owner: string | null, detail?: unknown) {
    this.team.audit(viewer, action, action.split(".")[0], targetId, owner, detail ?? null);
  }

  /** Everyone who can currently see a resource, for live updates. */
  audience(type: ShareType, id: string) {
    let owner: string | null;
    try {
      owner = this.ownerOf(type, id);
    } catch {
      return [];
    }
    const grants = this.grants(type, id);
    if (owner === null || grants.some((g) => g.grantee === "team")) return "*" as const;
    return [owner, ...grants.map((g) => g.grantee)];
  }
}
