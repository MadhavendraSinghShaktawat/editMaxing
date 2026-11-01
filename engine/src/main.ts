import { createServer } from "node:http";
import { Bus } from "./bus.ts";
import { Accounts } from "./claude/accounts.ts";
import { Chats } from "./claude/chat.ts";
import { PORT, ensureDirs } from "./config.ts";
import { Database } from "./db.ts";
import { Docs } from "./docs.ts";
import { Files, ToolCache } from "./files.ts";
import { Jobs } from "./jobs.ts";
import { Library } from "./library.ts";
import { epidemicEnv, mcpFor } from "./mcp.ts";
import { Memory } from "./memory.ts";
import { Packs } from "./packs.ts";
import { buildPrompt } from "./prompt.ts";
import { buildRouter, handler, installToken } from "./routes.ts";
import { Styles } from "./styles.ts";
import { Tools } from "./tools.ts";

ensureDirs();
const db = new Database();
const bus = new Bus();
const files = new Files(db);
const cache = new ToolCache(db);
const jobs = new Jobs(db, bus);
const accounts = new Accounts(db, bus);
const tools = new Tools(files, cache, jobs);
const memory = new Memory(db, bus);
const packs = new Packs(tools, jobs);
const styles = new Styles(db, bus, files, jobs, tools, accounts);

let chats: Chats;
const docs = new Docs(db, files, tools, jobs, () => chats);
const library = new Library(db, bus, files, jobs, accounts, () => chats.busy > 0);
chats = new Chats(db, bus, accounts, {
  mcp: (chat) => mcpFor(chat, { db, chats: () => chats, docs, files, library, styles, tools }),
  prompt: (chat) => buildPrompt(chat, styles, memory),
  env: epidemicEnv,
  onCorrection: (chat, text) => {
    const rule = memory.note(text, chat.id, (JSON.parse(chat.mission ?? "{}") as { modeId?: string }).modeId ?? null);
    if (rule) chats.note(chat.id, "system", "memory", `Saved to Personal Memory: ${rule.text}`);
  },
});

await accounts.init();
jobs.resume(["library.ingest", "library.drive", "library.analyze", "library.embed", "style.analyze", "pack.earshot", "pack.motion", "pack.depth", "pack.colmap"]);

const token = installToken();
const server = createServer(handler(buildRouter({ db, bus, files, jobs, accounts, chats, docs, library, styles, memory, packs }), token));
// Uploads and event streams stay open for a long time.
server.requestTimeout = 0;
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Is Shifu Dojo already running?` : e.message);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => console.log(`Shifu Dojo is running at http://127.0.0.1:${PORT}/?k=${token}`));

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
