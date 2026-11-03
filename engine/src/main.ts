import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Bus } from "./bus.ts";
import type { Audience } from "./bus.ts";
import { Accounts } from "./claude/accounts.ts";
import { Chats } from "./claude/chat.ts";
import type { ChatRow } from "./claude/chat.ts";
import { DIRS, HOME, PLUGIN_DIR, PORT, ensureDirs } from "./config.ts";
import { Database } from "./db.ts";
import { Docs } from "./docs.ts";
import { DriveSync } from "./drivesync.ts";
import { Files, ToolCache } from "./files.ts";
import { Jobs } from "./jobs.ts";
import { Library } from "./library.ts";
import { epidemicEnv, mcpFor, scrapeEnv } from "./mcp.ts";
import { Memory } from "./memory.ts";
import { MotionLibrary } from "./motionlib.ts";
import { Packs } from "./packs.ts";
import { buildPrompt } from "./prompt.ts";
import { buildRouter, epidemicKeyFor, handler, installToken } from "./routes.ts";
import { Styles } from "./styles.ts";
import { Access } from "./team/access.ts";
import { Team } from "./team/team.ts";
import { Tools } from "./tools.ts";

ensureDirs();
const db = new Database();
const bus = new Bus();
const team = new Team(db, bus);
const access = new Access(db, team);
const files = new Files(db);
const cache = new ToolCache(db);
const jobs = new Jobs(db, bus);
const accounts = new Accounts(db, bus);
const tools = new Tools(files, cache, jobs);
const memory = new Memory(db, bus, team, accounts, jobs);
const packs = new Packs(tools, jobs);
const styles = new Styles(db, bus, files, jobs, tools, accounts);
styles.access = access;
const drive = new DriveSync(db, bus, files, jobs, team);

let chats: Chats;
const docs = new Docs(db, files, tools, jobs, () => chats);
const library = new Library(db, bus, files, jobs, accounts, () => chats.busy > 0);
library.access = access;
library.onSharedChange = (id) => void drive.queue(id);
const motion = new MotionLibrary(db, bus, accounts);
motion.access = access;
motion.embedModel = () => library.embedModel;
styles.motion = motion;

const epidemicKey = (chat: ChatRow) => epidemicKeyFor(chat.owner_id, team.owner().id);
const scrapeOn = (chat: ChatRow) => !!chat.owner_id && db.setting(`m:${chat.owner_id}:scrapecreators`) === "on";

/**
 * On a Hub, a teammate's editor may read only their own mission, their own files and the libraries
 * they can use. The Owner's chats run as before, because the Owner already has the whole Mac.
 */
function isolation(chat: ChatRow) {
  if (team.mode !== "hub" || !chat.owner_id || chat.owner_id === team.owner().id) return null;
  const own = db.all<{ path: string }>("SELECT f.path FROM file_access a JOIN files f ON f.hash = a.hash WHERE a.member_id = ?", chat.owner_id).map((r) => r.path);
  const clips = library.clips(chat.owner_id).map((c) => db.get<{ path: string }>("SELECT f.path FROM clips c JOIN files f ON f.hash = c.file_hash WHERE c.id = ?", c.id)?.path).filter((p): p is string => !!p);
  const readable = [...new Set([PLUGIN_DIR, DIRS.packs, DIRS.cache, ...own, ...clips])];
  return {
    roots: readable,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: [HOME], allowRead: [chat.cwd, ...readable], allowWrite: [chat.cwd] },
    },
  };
}

chats = new Chats(db, bus, accounts, {
  mcp: (chat) => mcpFor(chat, { db, chats: () => chats, docs, files, library, motion, styles, tools, memory, epidemicKey, envato: (c) => db.setting(`m:${c.owner_id ?? team.owner().id}:envato`) === "on", scrape: (c) => scrapeOn(c) }),
  prompt: (chat) => buildPrompt(chat, styles, memory, (id) => db.get<{ name: string }>("SELECT name FROM clients WHERE id = ?", id)?.name ?? null),
  env: async (chat) => ({ ...(await epidemicEnv(epidemicKey(chat))), ...(await scrapeEnv(chat.owner_id, scrapeOn(chat))) }),
  onUserMessage: (chat, text) => chat.owner_id && memory.signal({ memberId: chat.owner_id, chatId: chat.id, clientId: chat.client_id, kind: "message", text }),
  onTurnEnd: (chat) => memory.schedule({ id: chat.id, owner_id: chat.owner_id, client_id: chat.client_id, account_id: chat.account_id }),
  isolation,
});

memory.onSuggest = (chatId, rule) => {
  try {
    chats.note(chatId, "system", "memory.suggest", rule.text, { ruleId: rule.id, area: rule.area, clientId: rule.clientId });
  } catch {
    // The chat ended while memory was learning. The suggestion still waits in Settings.
  }
};
team.onRemoved = (memberId) => chats.closeOwner(memberId);

/** Every event goes only to the person whose work it is. */
const one = (id: string | null | undefined): Audience => (id ? [id] : "admins");
const chatOwner = (id: unknown) => db.get<{ owner_id: string | null }>("SELECT owner_id FROM chats WHERE id = ?", String(id))?.owner_id;
const accountOwner = (id: unknown) => db.get<{ owner_id: string | null }>("SELECT owner_id FROM accounts WHERE id = ?", String(id))?.owner_id;
bus.audience = (type, data) => {
  const d = (data ?? {}) as Record<string, unknown>;
  if (type === "chat" || type === "chat.ended") return one(chatOwner(d.id));
  if (["message", "delta", "limit", "decision", "decision.closed"].includes(type)) return one(chatOwner(d.chatId));
  if (type === "account" || type === "account.login") return one(accountOwner(d.id));
  if (type === "job") return one(jobs.ownerOf(String(d.id)));
  return "admins";
};

// What a tool makes belongs to whoever ran it, so they can open it and nobody else can.
bus.on((e) => {
  if (e.type !== "job") return;
  const d = e.data as { id: string; status: string; result?: unknown };
  if (d.status !== "done" || !d.result) return;
  const owner = jobs.ownerOf(d.id);
  if (!owner) return;
  const walk = (v: unknown, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 4) return;
    const o = v as Record<string, unknown>;
    if (typeof o.hash === "string" && typeof o.path === "string") library.grantFile(owner, o.hash);
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(d.result);
});

await accounts.init();
jobs.resume(["library.ingest", "library.drive", "library.analyze", "library.embed", "library.drive.sync", "style.analyze", "memory.learn", "pack.earshot", "pack.motion", "pack.depth", "pack.colmap"]);

const token = installToken();
const server = createServer(handler(buildRouter({ db, bus, files, jobs, accounts, chats, docs, library, motion, styles, memory, packs, team, access, drive }), token, team));
// Uploads and event streams stay open for a long time.
server.requestTimeout = 0;
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Is Shifu Dojo already running?` : e.message);
  process.exit(1);
});
// Always loopback only. A Hub is reached through Tailscale Serve or a tunnel that forwards to this port.
server.listen(PORT, "127.0.0.1", () => console.log(`Shifu Dojo is running at http://127.0.0.1:${PORT}/?k=${token}`));

// Hub wind-down, expired sessions and stale memory are checked hourly, and once at start.
const housekeeping = () => {
  team.tick();
  memory.sweep();
};
housekeeping();
setInterval(housekeeping, 3_600_000).unref();

// A long edit shouldn't die because the Mac dozed off. Each hold lapses on its own, so a crash can't keep it awake.
const awake = setInterval(() => {
  if (chats.busy || jobs.busy) spawn("/usr/bin/caffeinate", ["-i", "-t", "70"], { stdio: "ignore", detached: true }).unref();
}, 60_000);
awake.unref();

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  chats.stop();
  accounts.stop();
  server.close();
  server.closeAllConnections();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
// If the Mac app crashes, the engine shouldn't outlive it.
if (process.env.DOJO_WATCH_PARENT) {
  const parent = process.ppid;
  setInterval(() => process.ppid !== parent && stop(), 3000).unref();
}
