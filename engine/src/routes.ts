import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve, sep } from "node:path";
import type { Bus } from "./bus.ts";
import type { Accounts } from "./claude/accounts.ts";
import type { Chats } from "./claude/chat.ts";
import { HOME, PORT, WEB_DIR } from "./config.ts";
import type { Database } from "./db.ts";
import { json } from "./db.ts";
import type { Docs } from "./docs.ts";
import type { Files } from "./files.ts";
import { HttpError, Router, readJson, sendFile, typeFor } from "./lib/http.ts";
import type { Ctx } from "./lib/http.ts";
import { secrets } from "./lib/secrets.ts";
import type { Jobs } from "./jobs.ts";
import type { Library } from "./library.ts";
import type { Memory } from "./memory.ts";
import type { PackId, Packs } from "./packs.ts";
import type { Styles } from "./styles.ts";
import { EDIT_MODES } from "./styles.ts";

export type App = { db: Database; bus: Bus; files: Files; jobs: Jobs; accounts: Accounts; chats: Chats; docs: Docs; library: Library; styles: Styles; memory: Memory; packs: Packs };

const KEYS = new Set(["openrouter", "google_api_key", "epidemic"]);
const TOOL_KINDS = new Set(["removeBackground", "transcribe", "cutSilences", "reframe", "parallax", "track"]);
const COOKIE = "dojo_session";

/** The token lives in a file only this macOS user can read. */
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

const cookieValue = (req: IncomingMessage) => req.headers.cookie?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

const LOOPBACK = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

export function authorize(req: IncomingMessage, token: string) {
  // A Host check stops DNS rebinding. An Origin check stops other websites posting here.
  if (!LOOPBACK.has(req.headers.host ?? "")) return "host";
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer && same(bearer, token)) return null;
  const origin = req.headers.origin;
  if (origin && !LOOPBACK.has(origin.replace(/^https?:\/\//, ""))) return "origin";
  const cookie = cookieValue(req);
  return cookie && same(cookie, token) ? null : "token";
}

export function buildRouter(app: App) {
  const { db, bus, files, jobs, accounts, chats, docs, library, styles, memory, packs } = app;
  const r = new Router();
  const body = async <T = Record<string, unknown>>(c: Ctx) => (await c.body()) as T;

  r.add("GET", "/api/state", async () => ({
    accounts: accounts.list(),
    chats: chats.list(),
    decisions: chats.openDecisions(),
    jobs: db.all("SELECT id, kind, status, progress, message, error FROM jobs WHERE status IN ('queued', 'running')"),
    library: library.stats(),
    styles: styles.list(),
    modes: EDIT_MODES,
    recipes: styles.recipes(),
    memory: memory.rules(),
    packs: packs.list(),
    keys: Object.fromEntries(await Promise.all([...KEYS].map(async (k) => [k, await secrets.has(k)] as const))),
    settings: { account: db.setting("account") ?? "default", model: db.setting("model") ?? "sonnet", effort: db.setting("effort") ?? "medium", embedModel: library.embedModel },
  }));
  r.add("GET", "/api/events", (c) => {
    bus.attach(c.res, Number(c.req.headers["last-event-id"] ?? c.query.get("since") ?? 0));
    return undefined;
  });
  r.add("GET", "/api/doctor", () => packs.doctor());

  r.add("POST", "/api/accounts", async (c) => {
    const b = await body<{ label?: string; apiKey?: string }>(c);
    const label = b.label?.trim() || "Claude account";
    return b.apiKey ? accounts.addApiKey(label, b.apiKey) : accounts.create(label, "subscription");
  });
  r.add("POST", "/api/accounts/:id/login", async (c) => {
    const b = await body<{ mode?: "claudeai" | "console" }>(c);
    await accounts.login(c.params.id, b.mode);
    return { ok: true };
  });
  r.add("POST", "/api/accounts/:id/login/cancel", (c) => (accounts.cancelLogin(c.params.id), { ok: true }));
  r.add("POST", "/api/accounts/:id/logout", async (c) => (await accounts.logout(c.params.id), { ok: true }));
  r.add("POST", "/api/accounts/:id/refresh", async (c) => (await accounts.refresh(c.params.id), accounts.get(c.params.id)));
  r.add("DELETE", "/api/accounts/:id", async (c) => (await accounts.remove(c.params.id), { ok: true }));

  r.add("POST", "/api/chats", async (c) => chats.create(await body(c)));
  r.add("GET", "/api/chats/:id/messages", (c) => ({ messages: chats.messages(c.params.id), decisions: chats.openDecisions(c.params.id) }));
  r.add("POST", "/api/chats/:id/messages", async (c) => {
    const b = await body<{ text?: string; attachments?: { hash: string; role?: string }[] }>(c);
    const attachments = (b.attachments ?? []).map((a) => {
      const f = files.get(a.hash);
      const duration = (f.meta as { duration?: number }).duration;
      return { hash: f.hash, name: f.name, role: a.role ?? "footage", path: f.path, kind: f.kind, duration };
    });
    if (!b.text?.trim() && !attachments.length) throw new HttpError(400, "Write a note or attach a file.");
    await chats.send(c.params.id, b.text ?? "", attachments);
    return { ok: true };
  });
  r.add("PATCH", "/api/chats/:id", async (c) => {
    const b = await body<{ model?: string; effort?: string | null; accountId?: string; brief?: Record<string, string> }>(c);
    if (b.accountId) chats.setAccount(c.params.id, b.accountId);
    if (b.model) chats.setModel(c.params.id, b.model, b.effort ?? null);
    if (b.brief) chats.setBrief(c.params.id, b.brief);
    return chats.view(chats.row(c.params.id));
  });
  r.add("POST", "/api/chats/:id/interrupt", async (c) => (await chats.interrupt(c.params.id), { ok: true }));
  r.add("DELETE", "/api/chats/:id", (c) => (chats.end(c.params.id), { ok: true }));
  r.add("GET", "/api/chats/:id/review", (c) => db.all<{ id: number; at_seconds: number | null; text: string; kind: string; data: string | null }>("SELECT id, at_seconds, text, kind, data FROM review_items WHERE chat_id = ? ORDER BY id", c.params.id).map((i) => ({ id: i.id, atSeconds: i.at_seconds, text: i.text, kind: i.kind, data: json(i.data, null) })));
  r.add("GET", "/api/chats/:id/versions", (c) => docs.versions(c.params.id));
  r.add("POST", "/api/chats/:id/restore", async (c) => docs.restore(c.params.id, Number((await body(c)).version)));
  r.add("GET", "/api/chats/:id/outputs", (c) => docs.outputs(c.params.id));
  r.add("GET", "/api/chats/:id/out/:name", (c) => {
    const path = join(chats.row(c.params.id).cwd, "out", basename(c.params.name));
    if (!existsSync(path)) throw new HttpError(404, "That file isn't there.");
    sendFile(c.req, c.res, path);
    return undefined;
  });
  r.add("POST", "/api/decisions/:id", async (c) => (chats.answer(c.params.id, (await body(c)).answer), { ok: true }));

  r.add("POST", "/api/files", async (c) => {
    const name = basename(c.query.get("name") ?? "upload");
    return files.fromStream(c.req, name);
  });
  r.add("GET", "/api/files/:hash", (c) => {
    const f = files.get(c.params.hash);
    sendFile(c.req, c.res, f.path, typeFor(f.name), "private, max-age=31536000, immutable");
    return undefined;
  });

  r.add("GET", "/api/jobs", () => db.all("SELECT id, kind, status, progress, message, error, result FROM jobs ORDER BY created_at DESC LIMIT 100").map((j) => ({ ...(j as { result: string | null }), result: json((j as { result: string | null }).result, null) })));
  r.add("DELETE", "/api/jobs/:id", (c) => (jobs.cancel(c.params.id), { ok: true }));

  r.add("GET", "/api/library", (c) => ({ stats: library.stats(), clips: library.clips(), tree: library.tree(c.query.get("prefix") ?? ""), gaps: library.gaps() }));
  r.add("POST", "/api/library/import", async (c) => {
    const b = await body<{ hashes: string[]; collection?: string; rights?: string }>(c);
    return { jobs: b.hashes.map((h) => library.enqueue(h, b.collection, null, b.rights ?? null)) };
  });
  r.add("POST", "/api/library/drive", async (c) => {
    const b = await body<{ links: string[]; collection?: string; rights?: string }>(c);
    return { job: jobs.add("library.drive", { links: b.links, collection: b.collection ?? "general", rights: b.rights ?? null }, { lane: "light" }) };
  });
  r.add("POST", "/api/library/analyze", async (c) => {
    const b = await body<{ count: number; accountId?: string; model?: string; collection?: string }>(c);
    return { job: jobs.add("library.analyze", { count: b.count, accountId: b.accountId ?? db.setting("account") ?? "default", model: b.model ?? "sonnet", collection: b.collection ?? null }, { lane: "claude", priority: 8 }) };
  });
  r.add("POST", "/api/library/search", async (c) => library.search(await body(c) as never));
  r.add("GET", "/api/library/browse", (c) => library.browse(c.query.get("path") ?? ""));
  r.add("GET", "/api/library/shots/:id/filmstrip", (c) => {
    const s = library.shot(c.params.id);
    sendFile(c.req, c.res, s.filmstrip!, "image/jpeg", "private, max-age=86400");
    return undefined;
  });

  r.add("POST", "/api/styles/learn", async (c) => {
    const b = await body<{ hash: string; accountId?: string; mode?: string; locale?: string }>(c);
    return { job: styles.learn(b.hash, b.accountId ?? db.setting("account") ?? "default", b.mode ?? null, b.locale) };
  });
  r.add("PATCH", "/api/styles/:id", async (c) => styles.update(c.params.id, await body(c)));
  r.add("DELETE", "/api/styles/:id", (c) => (styles.remove(c.params.id), { ok: true }));

  r.add("POST", "/api/recipes", async (c) => {
    const b = await body<{ title: string; text: string }>(c);
    return { id: styles.addRecipe(b.title, b.text) };
  });
  r.add("POST", "/api/recipes/:id/use", (c) => (styles.useRecipe(c.params.id), { ok: true }));
  r.add("DELETE", "/api/recipes/:id", (c) => (styles.removeRecipe(c.params.id), { ok: true }));

  r.add("PATCH", "/api/memory/:id", async (c) => (memory.update(c.params.id, String((await body(c)).text)), { ok: true }));
  r.add("DELETE", "/api/memory/:id", (c) => (memory.remove(c.params.id), { ok: true }));

  r.add("POST", "/api/tools/:kind", async (c) => {
    if (!TOOL_KINDS.has(c.params.kind)) throw new HttpError(404, "There is no such tool.");
    return { job: jobs.add(`tool.${c.params.kind}`, await body(c), { lane: c.params.kind === "transcribe" ? "light" : "heavy", priority: 4 }) };
  });
  r.add("GET", "/api/packs", () => packs.list());
  r.add("POST", "/api/packs/:id/install", (c) => ({ job: packs.install(c.params.id as PackId) }));

  // Keys go in and are never sent back. The app only learns whether one exists.
  r.add("POST", "/api/keys/:name", async (c) => {
    if (!KEYS.has(c.params.name)) throw new HttpError(404, "There is no such key.");
    await secrets.set(c.params.name, String((await body(c)).value));
    return { ok: true };
  });
  r.add("DELETE", "/api/keys/:name", async (c) => {
    if (!KEYS.has(c.params.name)) throw new HttpError(404, "There is no such key.");
    await secrets.remove(c.params.name);
    return { ok: true };
  });
  r.add("POST", "/api/settings", async (c) => {
    const b = await body<Record<string, string>>(c);
    for (const key of ["account", "usage_ceiling", "max_card_batch", "embed_model"]) if (b[key] !== undefined) db.setSetting(key, String(b[key]));
    return { ok: true };
  });
  return r;
}

const SIGN_IN = `<!doctype html><meta charset="utf-8"><title>Shifu Dojo</title><body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><p>Open Shifu Dojo from the Mac app.</p></body>`;

export function handler(router: Router, token: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    try {
      // One link from the Mac app or terminal becomes a same-site cookie, then the token leaves the address bar.
      const key = url.searchParams.get("k");
      if (key && !url.pathname.startsWith("/api/") && LOOPBACK.has(req.headers.host ?? "") && same(key, token)) {
        res.writeHead(302, { "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: "/" }).end();
        return;
      }
      const denied = authorize(req, token);
      if (denied) {
        if (!url.pathname.startsWith("/api/") && denied === "token") res.writeHead(401, { "Content-Type": "text/html" }).end(SIGN_IN);
        else res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not allowed." }));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const hit = router.match(req.method ?? "GET", url.pathname);
        if (!hit) throw new HttpError(404, "Not found.");
        let parsed: Promise<Record<string, unknown>> | null = null;
        const out = await hit.handler({ req, res, params: hit.params, query: url.searchParams, body: () => (parsed ??= readJson(req)) });
        if (out !== undefined && !res.headersSent) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
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
