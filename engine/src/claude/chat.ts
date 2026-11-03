import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync, existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, McpServerConfig, Query, SandboxSettings, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Bus } from "../bus.ts";
import { DIRS, HOME, MOTION_MODULES, MOTION_PYTHON, PLUGIN_DIR } from "../config.ts";
import { MOTION_AGENT } from "../prompt.ts";
import type { Database } from "../db.ts";
import { json } from "../db.ts";
import { AsyncQueue } from "../lib/dsa.ts";
import { HttpError } from "../lib/http.ts";
import type { Accounts } from "./accounts.ts";
import { checkAgent, describeRequest, checkTool, inside } from "./policy.ts";

export type Station = "library" | "cutting" | "animation" | "captions" | "living" | "sound" | "render" | "review";
export type ChatStatus = "idle" | "working" | "thinking" | "needs" | "stuck" | "resting";

export type ChatRow = {
  id: string; name: string; look: number; account_id: string; model: string; effort: string | null; session_id: string | null;
  cwd: string; status: ChatStatus; detail: string; station: Station; stage: string | null; mission: string | null; cost: number;
  created_at: number; updated_at: number; ended_at: number | null; owner_id: string | null; client_id: string | null; context?: string | null;
  /** Set on a spawned agent's chat: the chat that started it. Such a chat is read-only. */
  parent_id?: string | null; task_id?: string | null;
};

/** The look a spawned agent's character wears in the studio. */
const CHILD_LOOK = 5;
const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export const NAMES = [["Kai", 0], ["Noor", 1], ["Sora", 2], ["Aigerim", 3], ["Leo", 4], ["Mei", 5], ["Wayan", 6], ["Dewi", 7]] as const;
export const MAX_CHATS = NAMES.length;
const IDLE_CLOSE_MS = 15 * 60_000;

/** Where an editor should stand for a tool. Only changes the world view, never behaviour. */
export function stationFor(tool: string, input: Record<string, unknown>): { station: Station; detail: string } | null {
  const name = tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "");
  if (tool === "Skill") {
    const skill = String(input.skill ?? input.command ?? "");
    if (/broll|explainer|motion/.test(skill)) return { station: "animation", detail: "Building motion graphics" };
    if (/sound|earshot/.test(skill)) return { station: "sound", detail: "Designing sound" };
    if (/separation/.test(skill)) return { station: "animation", detail: "Separating the subject" };
    return { station: "cutting", detail: "Planning the edit" };
  }
  if (tool.startsWith("mcp__earshot__")) return { station: "sound", detail: "Listening to the audio" };
  if (tool.startsWith("mcp__epidemic__")) return { station: "sound", detail: "Searching sound effects" };
  if (tool.startsWith("mcp__envato__")) return /music|sound/.test(tool) ? { station: "sound", detail: "Searching Envato Elements" } : { station: "library", detail: "Searching Envato Elements" };
  if (/search_broll|browse_library|view_filmstrip|find_similar|use_clip/.test(name)) return { station: "library", detail: "Searching B-roll" };
  if (/transcribe|analyze_takes|edit_ops|get_edit/.test(name)) return { station: "cutting", detail: "Cutting A-roll" };
  if (/caption/.test(name)) return { station: "captions", detail: "Timing captions" };
  if (/render|quality_check|export/.test(name)) return { station: "render", detail: "Rendering" };
  if (/remove_background|depth|parallax|track/.test(name)) return { station: "animation", detail: "Running a video tool" };
  if (/brief_motion_agent/.test(name) || tool === "Agent" || tool === "Task") return { station: "animation", detail: "Briefing the Motion agent" };
  if (tool === "Bash") {
    const c = String(input.command ?? "");
    if (/render\.js|playwright/.test(c)) return { station: "render", detail: "Rendering" };
    if (/ffmpeg|ffprobe/.test(c)) return { station: "cutting", detail: "Working on the video" };
  }
  return null;
}

/** What a chat is making, chosen once so the editor never has to ask again. */
/** How a reference's marks read to the editor. */
const TAG_LABELS: Record<string, string> = { editing: "editing and pacing", motion: "motion graphics", explainer: "explainer graphics", captions: "captions", sound: "sound" };

export type Brief = { title?: string; styleId?: string | null; reason?: string; locale?: string; script?: string };

type Pending = { resolve: (answer: unknown) => void; chatId: string };

type Runtime = {
  q: Query; input: AsyncQueue<SDKUserMessage>; idle: NodeJS.Timeout | null; allowed: Set<string>; motion: Set<string>; spawning: boolean; compaction: number | null;
  /** Each spawned agent's chat, by the tool call that started it, so its activity lands there. */
  children: Map<string, string>;
};

/** Sent to an editor whose turn a restart cut short. Worded as in T3 Code. */
export const CONTINUE_PROMPT = "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.";
/** A turn that keeps crashing the engine would otherwise restart it forever. */
export const MAX_RESTART_CONTINUATIONS = 3;
const RESTART_LOOP_WINDOW_MS = 5 * 60_000;

/** Restarts of one chat within the loop window. At the limit, the chat waits for the user. */
export const recentRestarts = (times: number[], now: number) => times.filter((t) => now - t < RESTART_LOOP_WINDOW_MS);

/** The message that continues a cut-off turn, listing Motion agent work that died with the engine. */
export function continuationText(lost: { description: string }[]) {
  if (!lost.length) return CONTINUE_PROMPT;
  return [
    "Note: Shifu Dojo restarted, and this background work was cancelled before it finished. It will not report back on its own, so resume or restart what you still need and wait for its result:",
    ...lost.slice(0, 10).map((t) => `- subagent: Motion agent${t.description ? ` (${t.description.replace(/\s+/g, " ").slice(0, 140)})` : ""}`),
    ...(lost.length > 10 ? [`- and ${lost.length - 10} more`] : []),
    "",
    CONTINUE_PROMPT,
  ].join("\n");
}

/** How full the chat's context window is, as Claude Code last reported it. */
export type ContextUsage = { usedTokens: number; maxTokens: number | null; percentage: number | null; model: string | null; compactsAutomatically: boolean; autoCompactThreshold: number | null; updatedAt: number };

export type ChatDeps = {
  mcp: (chat: ChatRow) => Promise<Record<string, McpServerConfig>>;
  prompt: (chat: ChatRow) => string;
  env?: (chat: ChatRow) => Promise<Record<string, string>>;
  /** Every note a person writes in a chat. Memory reads these, never the footage. */
  onUserMessage?: (chat: ChatRow, text: string) => void;
  /** The editor finished a turn and is waiting, which is when memory learns. */
  onTurnEnd?: (chat: ChatRow) => void;
  /**
   * References shared in a message: each is matched with the person's library or learned in the
   * background. Returns one line per reference for the editor, and the style to use when one is known.
   */
  onReferences?: (chat: ChatRow, refs: { hash: string; tags?: string[] }[]) => Promise<{ notes: Map<string, string>; styleId: string | null }>;
  /**
   * On a Hub, editors run for different people on one Mac. This returns the folders a chat may read
   * outside its own mission, and the shell sandbox that enforces it. Null means a single-user studio.
   */
  isolation?: (chat: ChatRow) => { roots: string[]; sandbox: SandboxSettings } | null;
};

export class Chats {
  private db: Database;
  private bus: Bus;
  private accounts: Accounts;
  private deps: ChatDeps;
  private runtimes = new Map<string, Runtime>();
  private pending = new Map<string, Pending>();

  constructor(db: Database, bus: Bus, accounts: Accounts, deps: ChatDeps) {
    this.db = db;
    this.bus = bus;
    this.accounts = accounts;
    this.deps = deps;
    // Turns that were running when the engine stopped are continued once it's ready, like T3 Code.
    this.interrupted = db.all<{ id: string }>("SELECT id FROM chats WHERE status IN ('working', 'thinking', 'needs') AND ended_at IS NULL AND session_id IS NOT NULL").map((r) => r.id);
    // A spawned agent dies with the engine. Its chat says so; the resumed parent starts a new one.
    for (const c of db.all<{ id: string }>("SELECT id FROM chats WHERE parent_id IS NOT NULL AND ended_at IS NULL AND status IN ('working', 'thinking', 'needs')")) {
      db.run("UPDATE chats SET status = 'idle', detail = 'Stopped when Shifu Dojo restarted' WHERE id = ?", c.id);
    }
    this.interrupted = this.interrupted.filter((x) => !db.get("SELECT 1 FROM chats WHERE id = ? AND parent_id IS NOT NULL", x));
    // Nothing can still be running after a restart. Unanswered questions were asked by a dead process.
    db.run("UPDATE chats SET status = 'idle', detail = '' WHERE status IN ('working', 'thinking', 'needs')");
    db.run("UPDATE decisions SET status = 'expired' WHERE status = 'open'");
  }

  private interrupted: string[] = [];

  /**
   * After a restart, each turn that was cut short continues by itself: the editor is told to pick
   * up where it left off and to check what already finished before repeating anything, and any
   * Motion agent work that died with the engine is listed so it's started again. A chat that keeps
   * restarting (3 times within 5 minutes) waits for the user instead of looping.
   */
  async resumeInterrupted() {
    const ids = this.interrupted;
    this.interrupted = [];
    for (const id of ids) {
      try {
        const chat = this.row(id);
        if (chat.ended_at) continue;
        const now = Date.now();
        const recent = recentRestarts(json<number[]>(this.db.setting(`c:${id}:restarts`), []), now);
        const lost = json<{ id: string; description: string }[]>(this.db.setting(`c:${id}:motion`), []);
        this.db.setSetting(`c:${id}:motion`, "[]");
        if (recent.length >= MAX_RESTART_CONTINUATIONS) {
          this.message(id, "system", "text", "Shifu Dojo restarted several times in a few minutes, so this edit is paused. Send a message to continue.");
          continue;
        }
        this.db.setSetting(`c:${id}:restarts`, JSON.stringify([...recent, now]));
        const text = continuationText(lost);
        this.message(id, "system", "text", lost.length ? "Shifu Dojo restarted and resumed this turn. The Motion agent's unfinished graphics will be started again." : "Shifu Dojo restarted and resumed this turn.");
        const rt = await this.ensure(id);
        this.status(id, { status: "thinking", detail: "Picking up where it left off" });
        rt.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, origin: { kind: "human" } } as SDKUserMessage);
      } catch (e) {
        console.warn(`Couldn't resume chat ${id}: ${(e as Error).message}`);
      }
    }
  }

  row(id: string) {
    const r = this.db.get<ChatRow>("SELECT * FROM chats WHERE id = ?", id);
    if (!r) throw new Error("That chat no longer exists.");
    return r;
  }

  view(r: ChatRow) {
    return { id: r.id, name: r.name, look: r.look, ownerId: r.owner_id, clientId: r.client_id, accountId: r.account_id, model: r.model, effort: r.effort, status: r.status, detail: r.detail, station: r.station, stage: r.stage, mission: json(r.mission, null), cost: r.cost, createdAt: r.created_at, updatedAt: r.updated_at, context: json<ContextUsage | null>(r.context ?? null, null), parentId: r.parent_id ?? null };
  }

  /** Open chats for one person. Each person has their own studio, so nobody sees another's editors. */
  list(ownerId: string) {
    return this.db.all<ChatRow>("SELECT * FROM chats WHERE ended_at IS NULL AND owner_id = ? ORDER BY created_at", ownerId).map((r) => this.view(r));
  }

  /** Every chat a person ever had, for admins in Settings → Users. */
  history(ownerId: string, limit = 200) {
    return this.db.all<ChatRow>("SELECT * FROM chats WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?", ownerId, limit).map((r) => ({ ...this.view(r), endedAt: r.ended_at }));
  }

  messages(id: string) {
    return this.db.all<{ id: number; role: string; kind: string; text: string; data: string | null; created_at: number }>("SELECT * FROM messages WHERE chat_id = ? ORDER BY id", id).map((m) => ({ id: m.id, role: m.role, kind: m.kind, text: m.text, data: json(m.data, null), createdAt: m.created_at }));
  }

  openDecisions(where: { chatId: string } | { ownerId: string }) {
    const rows = "chatId" in where
      ? this.db.all<{ id: string; chat_id: string; kind: string; payload: string }>("SELECT * FROM decisions WHERE status = 'open' AND chat_id = ?", where.chatId)
      : this.db.all<{ id: string; chat_id: string; kind: string; payload: string }>("SELECT d.* FROM decisions d JOIN chats c ON c.id = d.chat_id WHERE d.status = 'open' AND c.owner_id = ?", where.ownerId);
    return rows.map((d) => ({ id: d.id, chatId: d.chat_id, kind: d.kind, payload: json(d.payload, {}) }));
  }

  create(ownerId: string, options: { accountId?: string; model?: string; effort?: string; brief?: Brief; clientId?: string | null }) {
    const open = this.db.all<{ name: string }>("SELECT name FROM chats WHERE ended_at IS NULL AND owner_id = ? AND parent_id IS NULL", ownerId).map((r) => r.name);
    if (open.length >= MAX_CHATS) throw new Error("Your studio is full. End a chat to make room.");
    const [name, look] = NAMES.find(([n]) => !open.includes(n))!;
    // Everyone brings their own Claude login. A chat can only run on an account its person owns.
    const accountId = options.accountId ?? this.db.setting(`m:${ownerId}:account`) ?? this.accounts.firstFor(ownerId);
    if (!accountId) throw new Error("Add your Claude account first, in the account menu at the top.");
    const account = this.accounts.owned(ownerId, accountId);
    if (!account.signedIn) throw new Error(`${account.label} isn't signed in yet.`);
    const id = randomUUID();
    const cwd = join(DIRS.missions, id);
    for (const dir of ["inputs", "work", "out", "motion"]) mkdirSync(join(cwd, dir), { recursive: true });
    if (existsSync(MOTION_MODULES)) symlinkSync(MOTION_MODULES, join(cwd, "motion/node_modules"));
    const now = Date.now();
    const model = options.model ?? this.db.setting(`m:${ownerId}:model`) ?? "sonnet";
    const effort = options.effort ?? this.db.setting(`m:${ownerId}:effort`) ?? "medium";
    this.db.run("INSERT INTO chats (id, name, look, account_id, model, effort, cwd, mission, created_at, updated_at, owner_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, name, look, account.id, model, effort, cwd, JSON.stringify(options.brief ?? {}), now, now, ownerId, options.clientId ?? null);
    const view = this.view(this.row(id));
    this.bus.emit("chat", view);
    return view;
  }

  /**
   * A chat for an agent another chat started, such as the Motion agent. It shows what the agent
   * does, live, and can't be written to: the chat that started it directs it.
   */
  private spawnChild(parentId: string, rt: Runtime, task: { taskId: string; toolUseId?: string; description: string; subagent?: string }) {
    const parent = this.row(parentId);
    const id = randomUUID();
    const now = Date.now();
    const name = task.subagent === "motion" ? "Motion agent" : `${titleCase(task.subagent ?? "helper")} agent`;
    this.db.run(
      "INSERT INTO chats (id, name, look, account_id, model, effort, cwd, mission, status, detail, station, created_at, updated_at, owner_id, client_id, parent_id, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, 'animation', ?, ?, ?, ?, ?, ?)",
      id, name, CHILD_LOOK, parent.account_id, parent.model, parent.effort, parent.cwd, JSON.stringify({ title: task.description.slice(0, 80) || `${name} for ${parent.name}` }), "Starting", now, now, parent.owner_id, parent.client_id, parentId, task.taskId,
    );
    if (task.toolUseId) rt.children.set(task.toolUseId, id);
    this.message(id, "system", "text", `${parent.name} started this agent. You can watch it here; to change anything, write to ${parent.name}.`);
    this.bus.emit("chat", this.view(this.row(id)));
    return id;
  }

  /** A spawned agent's chat for one of its messages, by the tool call that started it. */
  private childFor(parentId: string, rt: Runtime, toolUseId: string | null | undefined) {
    if (!toolUseId) return null;
    const known = rt.children.get(toolUseId);
    if (known) return known;
    // After a restart the map is empty; the task's chat is found again by its tool call.
    const row = this.db.get<{ id: string }>("SELECT id FROM chats WHERE parent_id = ? AND ended_at IS NULL AND json_extract(mission, '$.toolUseId') = ?", parentId, toolUseId);
    if (row) rt.children.set(toolUseId, row.id);
    return row?.id ?? null;
  }

  /** What a spawned agent does, in its own chat: its words, each step, and where it's working. */
  private childActivity(childId: string, m: SDKMessage) {
    if (m.type !== "assistant") return;
    for (const block of m.message.content) {
      if (block.type === "text" && block.text.trim()) this.message(childId, "editor", "text", block.text);
      else if (block.type === "tool_use") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (QUIET.test(block.name)) continue;
        const label = typeof input.description === "string" && input.description.trim() ? input.description.trim() : toolLabel(block.name, input);
        this.message(childId, "editor", "tool", label, { tool: block.name });
        this.status(childId, { status: "working", detail: label });
      }
    }
  }

  private message(chatId: string, role: string, kind: string, text: string, data?: unknown) {
    const now = Date.now();
    const info = this.db.run("INSERT INTO messages (chat_id, role, kind, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", chatId, role, kind, text, data === undefined ? null : JSON.stringify(data), now);
    const message = { id: Number(info.lastInsertRowid), chatId, role, kind, text, data: data ?? null, createdAt: now };
    this.bus.emit("message", message);
    return message;
  }

  note(chatId: string, role: string, kind: string, text: string, data?: unknown) {
    return this.message(chatId, role, kind, text, data);
  }

  /** Changes a message in place, such as a compaction row going from running to done. */
  private amend(chatId: string, messageId: number, text: string, data: unknown) {
    this.db.run("UPDATE messages SET text = ?, data = ? WHERE id = ? AND chat_id = ?", text, JSON.stringify(data), messageId, chatId);
    this.bus.emit("message", { id: messageId, chatId, role: "system", kind: "compaction", text, data, amended: true });
  }

  /** The compaction row: one per compaction, shown as a divider in the chat. */
  private compactionRow(id: string, rt: Runtime, patch: { status: "running" | "done" | "failed"; before?: number; after?: number; trigger?: string; error?: string }) {
    const label = patch.status === "running" ? "Compacting context" : patch.status === "failed" ? "Context compaction failed" : "Context compacted";
    if (rt.compaction === null) {
      rt.compaction = this.message(id, "system", "compaction", label, patch).id;
    } else {
      const old = json<Record<string, unknown>>(this.db.get<{ data: string | null }>("SELECT data FROM messages WHERE id = ?", rt.compaction)?.data ?? null, {});
      this.amend(id, rt.compaction, label, { ...old, ...patch });
    }
    if (patch.status !== "running") rt.compaction = null;
  }

  /** Reads how full the context window is, after each turn and each compaction. */
  private async readContext(id: string, rt: Runtime) {
    try {
      const u = await rt.q.getContextUsage({ detail: "summary" });
      const auto = u as { isAutoCompactEnabled?: boolean; autoCompactThreshold?: number };
      const usage: ContextUsage = { usedTokens: Math.max(0, Math.round(u.totalTokens)), maxTokens: u.rawMaxTokens || u.maxTokens || null, percentage: Number.isFinite(u.percentage) ? u.percentage : null, model: u.model ?? null, compactsAutomatically: auto.isAutoCompactEnabled !== false, autoCompactThreshold: auto.autoCompactThreshold ?? null, updatedAt: Date.now() };
      this.db.run("UPDATE chats SET context = ? WHERE id = ?", JSON.stringify(usage), id);
      this.bus.emit("chat", this.view(this.row(id)));
    } catch {
      // A session that just closed can't answer. The last reading stays.
    }
  }

  /**
   * Compacts a chat's history the way Claude Code does: a /compact turn that summarizes the
   * conversation so far. Shown as a divider with the token counts before and after.
   */
  async compact(id: string) {
    const chat = this.row(id);
    if (chat.status === "working" || chat.status === "thinking") throw new HttpError(409, `Wait for ${chat.name} to finish this turn.`);
    const rt = await this.ensure(id);
    if (rt.compaction === null) this.compactionRow(id, rt, { status: "running", trigger: "manual" });
    this.status(id, { status: "thinking", detail: "Compacting context" });
    rt.input.push({ type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null, origin: { kind: "human" } } as SDKUserMessage);
  }

  status(id: string, patch: { status?: ChatStatus; detail?: string; station?: Station; stage?: string | null; mission?: unknown; cost?: number; session_id?: string }) {
    const r = this.row(id);
    const next = { ...r, ...patch, mission: patch.mission === undefined ? r.mission : JSON.stringify(patch.mission) };
    this.db.run("UPDATE chats SET status = ?, detail = ?, station = ?, stage = ?, mission = ?, cost = ?, session_id = ?, updated_at = ? WHERE id = ?", next.status, next.detail, next.station, next.stage, next.mission, next.cost, next.session_id, Date.now(), id);
    this.bus.emit("chat", this.view(this.row(id)));
  }

  /** The next message restarts the editor with the new style. Its conversation carries on. */
  setBrief(id: string, patch: Brief) {
    this.status(id, { mission: { ...json<Brief>(this.row(id).mission, {}), ...patch } });
    const rt = this.runtimes.get(id);
    if (rt?.idle) this.close(id);
  }

  setModel(id: string, model: string, effort: string | null) {
    const owner = this.row(id).owner_id;
    this.db.run("UPDATE chats SET model = ?, effort = ? WHERE id = ?", model, effort, id);
    this.db.setSetting(`m:${owner}:model`, model);
    if (effort) this.db.setSetting(`m:${owner}:effort`, effort);
    const rt = this.runtimes.get(id);
    if (rt) {
      void rt.q.setModel(model).catch(() => {});
      if (effort) void rt.q.applyFlagSettings({ effortLevel: effort as "low" }).catch(() => {});
    }
    this.bus.emit("chat", this.view(this.row(id)));
  }

  /** An account is fixed once a conversation starts, because its transcript lives in that account's home. */
  setAccount(id: string, accountId: string) {
    const r = this.row(id);
    if (r.session_id) throw new Error("This chat already started on another account. Start a new chat to switch.");
    this.accounts.owned(r.owner_id ?? "", accountId);
    this.db.run("UPDATE chats SET account_id = ? WHERE id = ?", accountId, id);
    this.db.setSetting(`m:${r.owner_id}:account`, accountId);
    this.bus.emit("chat", this.view(this.row(id)));
  }

  async send(id: string, text: string, attachments: { hash: string; name: string; role: string; path: string; kind: string; duration?: number; tags?: string[] }[] = [], options: { compactFirst?: boolean } = {}) {
    const chat = this.row(id);
    const brief = json<Brief>(chat.mission, {});
    if (text.trim() && !text.startsWith("/")) this.deps.onUserMessage?.(chat, text);
    // A reference already in the library brings its style; a new one starts learning. A failure here never stops the message.
    const refs = attachments.filter((a) => a.role === "reference" && a.kind === "video");
    const library = refs.length && this.deps.onReferences ? await this.deps.onReferences(chat, refs.map((a) => ({ hash: a.hash, tags: a.tags }))).catch(() => null) : null;
    if (library?.styleId && !brief.styleId) this.setBrief(id, { styleId: library.styleId });
    const lines: string[] = [];
    for (const a of attachments) {
      const safe = basename(a.name).replace(/[^\w.\- ]+/g, "_");
      const link = join(chat.cwd, "inputs", `${a.hash.slice(0, 8)}-${safe}`);
      if (!existsSync(link)) symlinkSync(a.path, link);
      const use = a.role === "reference" && a.tags?.length ? ` for ${a.tags.map((t) => TAG_LABELS[t] ?? t).join(", ")}` : "";
      const known = library?.notes.get(a.hash);
      lines.push(`- inputs/${basename(link)} (${a.role}${use}${a.duration ? `, ${a.duration.toFixed(1)}s` : ""})${known ? `: ${known}` : ""}`);
    }
    this.message(id, "user", "text", text, attachments.length ? { attachments } : undefined);
    if (!brief.title && (text.trim() || attachments.length)) {
      this.status(id, { mission: { ...json<Brief>(this.row(id).mission, {}), title: text.trim().slice(0, 60) || attachments[0].name.replace(/\.[^.]+$/, "") } });
    }
    const content = lines.length ? `${text}\n\nAttached files:\n${lines.join("\n")}` : text;
    const rt = await this.ensure(id);
    // "Compact and send": the history is summarized first, then the message goes in on top.
    if (options.compactFirst) {
      if (rt.compaction === null) this.compactionRow(id, rt, { status: "running", trigger: "manual" });
      rt.input.push({ type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null, origin: { kind: "human" } } as SDKUserMessage);
    }
    this.status(id, { status: "thinking", detail: options.compactFirst ? "Compacting context" : "Reading your note" });
    rt.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, origin: { kind: "human" } } as SDKUserMessage);
  }

  private async ensure(id: string) {
    const existing = this.runtimes.get(id);
    if (existing) {
      if (existing.idle) clearTimeout(existing.idle);
      existing.idle = null;
      return existing;
    }
    const chat = this.row(id);
    const input = new AsyncQueue<SDKUserMessage>();
    // What this chat was allowed to do survives the session closing when it goes idle.
    const allowed = new Set<string>(json<string[]>(this.db.setting(`c:${id}:allowed`), []));
    const canUseTool: CanUseTool = (name, toolInput, options) => this.permission(id, name, toolInput, options.signal, allowed, options.agentID);
    const account = await this.accounts.options(chat.account_id);
    const isolation = this.deps.isolation?.(chat) ?? null;
    const q = query({
      prompt: input,
      options: {
        ...account,
        // Renders and first-run model loads take far longer than a normal tool call.
        env: { ...account.env, ...(await this.deps.env?.(chat)), PATH: `${MOTION_PYTHON}${delimiter}${account.env?.PATH}`, MCP_TIMEOUT: "60000", MCP_TOOL_TIMEOUT: "3600000", DOJO_MOTION_KIT: join(PLUGIN_DIR, "skills/motion-broll"), BASH_DEFAULT_TIMEOUT_MS: "1800000", BASH_MAX_TIMEOUT_MS: "3600000" },
        cwd: chat.cwd,
        model: chat.model,
        effort: (chat.effort ?? undefined) as "medium" | undefined,
        resume: chat.session_id ?? undefined,
        settingSources: [],
        plugins: existsSync(PLUGIN_DIR) ? [{ type: "local", path: PLUGIN_DIR }] : [],
        mcpServers: await this.deps.mcp(chat),
        agents: {
          motion: {
            description: "Builds a premium motion graphic from a brief while you carry on with the edit. Give it every brief at once.",
            prompt: MOTION_AGENT,
            model: "inherit",
            effort: "high",
            background: true,
            skills: ["shifu-dojo:motion-artist"],
            tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "mcp__dojo__view_frames", "mcp__dojo__check_motion"],
            disallowedTools: ["Agent", "Task"],
          },
        },
        canUseTool,
        ...(isolation ? { sandbox: isolation.sandbox } : {}),
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.deps.prompt(chat) },
      },
    });
    const rt: Runtime = { q, input, idle: null, allowed, motion: new Set(), spawning: false, compaction: null, children: new Map() };
    this.runtimes.set(id, rt);
    void this.pump(id, rt);
    return rt;
  }

  private async pump(id: string, rt: Runtime) {
    let draft = "";
    try {
      for await (const m of rt.q) draft = this.handle(id, m, draft, rt);
    } catch (e) {
      const message = (e as Error).message;
      if (this.runtimes.get(id) === rt && !/abort/i.test(message)) {
        this.message(id, "system", "error", message);
        this.status(id, { status: "stuck", detail: "Hit a problem" });
      }
    } finally {
      if (this.runtimes.get(id) === rt) this.runtimes.delete(id);
    }
  }

  private handle(id: string, m: SDKMessage, draft: string, rt: Runtime) {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") this.status(id, { session_id: m.session_id });
        else if (m.subtype === "status") {
          if (m.status === "compacting") {
            if (rt.compaction === null) this.compactionRow(id, rt, { status: "running", trigger: "auto" });
            this.status(id, { detail: "Compacting context" });
          } else if (m.compact_result === "failed" && rt.compaction !== null) {
            this.compactionRow(id, rt, { status: "failed", error: m.compact_error });
          }
        } else if (m.subtype === "compact_boundary") {
          this.compactionRow(id, rt, { status: "done", before: m.compact_metadata.pre_tokens, after: m.compact_metadata.post_tokens, trigger: m.compact_metadata.trigger });
          void this.readContext(id, rt);
        }
        else if (m.subtype === "task_started" && m.subagent_type === "motion") {
          rt.motion.add(m.task_id);
          // Remembered on disk, so work cut off by a restart can be named and started again.
          const running = json<{ id: string; description: string }[]>(this.db.setting(`c:${id}:motion`), []);
          this.db.setSetting(`c:${id}:motion`, JSON.stringify([...running.filter((t) => t.id !== m.task_id), { id: m.task_id, description: String((m as { description?: string }).description ?? (m as { prompt?: string }).prompt ?? "") }]));
          rt.spawning = false;
          const child = this.spawnChild(id, rt, { taskId: m.task_id, toolUseId: m.tool_use_id, description: m.description, subagent: m.subagent_type });
          if (m.tool_use_id) this.db.run("UPDATE chats SET mission = json_set(mission, '$.toolUseId', ?) WHERE id = ?", m.tool_use_id, child);
          this.message(id, "editor", "tool", "The Motion agent started building", { tool: "Agent", childId: child });
        } else if (m.subtype === "task_progress") {
          const child = this.db.get<{ id: string }>("SELECT id FROM chats WHERE parent_id = ? AND task_id = ? AND ended_at IS NULL", id, m.task_id)?.id;
          if (child && m.description) this.status(child, { status: "working", detail: (m.summary ?? m.description).slice(0, 120) });
        } else if (m.subtype === "task_notification" && rt.motion.delete(m.task_id)) {
          const child = this.db.get<{ id: string }>("SELECT id FROM chats WHERE parent_id = ? AND task_id = ? AND ended_at IS NULL", id, m.task_id)?.id;
          if (child) {
            const done = m.status === "completed";
            if (m.summary?.trim()) this.message(child, "editor", "text", m.summary.trim());
            this.message(child, "system", "text", done ? `Finished. ${this.row(id).name} is placing the result.` : "Stopped before it finished.");
            this.status(child, { status: "idle", detail: done ? "Finished" : "Stopped" });
          }
          this.db.setSetting(`c:${id}:motion`, JSON.stringify(json<{ id: string; description: string }[]>(this.db.setting(`c:${id}:motion`), []).filter((t) => t.id !== m.task_id)));
          const ok = m.status === "completed";
          this.message(id, "editor", "tool", ok ? "The Motion agent finished" : "The Motion agent stopped early", { tool: "Agent" });
          if (this.row(id).status === "working") this.status(id, { detail: "Placing the motion graphic" });
        }
        break;
      case "stream_event": {
        const e = m.event as { type: string; delta?: { type: string; text?: string } };
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && !m.parent_tool_use_id) {
          draft += e.delta.text ?? "";
          this.bus.emit("delta", { chatId: id, text: draft });
        }
        break;
      }
      case "assistant": {
        if (m.parent_tool_use_id) {
          const child = this.childFor(id, rt, m.parent_tool_use_id);
          if (child) this.childActivity(child, m);
          break;
        }
        for (const block of m.message.content) {
          if (block.type === "text" && block.text.trim()) {
            this.message(id, "editor", "text", block.text);
            draft = "";
          } else if (block.type === "tool_use") {
            const input = (block.input ?? {}) as Record<string, unknown>;
            if (QUIET.test(block.name)) continue;
            const where = stationFor(block.name, input);
            this.message(id, "editor", "tool", toolLabel(block.name, input), { tool: block.name });
            this.status(id, { status: "working", ...(where ?? { detail: toolLabel(block.name, input) }) });
          }
        }
        break;
      }
      case "result": {
        const errors = m.subtype === "success" ? [] : m.errors ?? [];
        if (m.subtype !== "success" && !errors.some((e) => /interrupt|aborted/i.test(e))) this.message(id, "system", "error", errors[0] ?? `The editor stopped: ${m.subtype}`);
        rt.spawning = false;
        // The editor can finish its turn while the Motion agent works. Its report starts the next turn by itself.
        if (rt.motion.size && m.subtype === "success") {
          this.status(id, { status: "working", detail: "The Motion agent is building a graphic", station: "animation", cost: m.total_cost_usd });
          if (rt.compaction !== null) this.compactionRow(id, rt, { status: "done" });
          void this.readContext(id, rt);
          this.accounts.noteRateLimit(this.row(id).account_id);
          break;
        }
        this.status(id, { status: m.subtype === "success" ? "idle" : "stuck", detail: m.subtype === "success" ? "" : "Stopped", cost: m.total_cost_usd });
        if (rt.compaction !== null) this.compactionRow(id, rt, { status: m.subtype === "success" ? "done" : "failed", error: m.subtype === "success" ? undefined : errors[0] });
        void this.readContext(id, rt);
        if (m.subtype === "success") this.deps.onTurnEnd?.(this.row(id));
        rt.idle = setTimeout(() => this.close(id), IDLE_CLOSE_MS);
        rt.idle.unref();
        this.accounts.noteRateLimit(this.row(id).account_id);
        break;
      }
      case "rate_limit_event":
        this.accounts.noteRateLimit(this.row(id).account_id);
        if (m.rate_limit_info.status === "rejected") {
          this.status(id, { status: "resting", detail: "Waiting for the usage limit to reset" });
          this.bus.emit("limit", { chatId: id, resetsAt: m.rate_limit_info.resetsAt ?? null, type: m.rate_limit_info.rateLimitType ?? null });
        }
        break;
      default:
    }
    return draft;
  }

  private async permission(id: string, name: string, input: Record<string, unknown>, signal: AbortSignal, allowed: Set<string>, agent?: string) {
    const chat = this.row(id);
    // A background command would let the Motion agent report done before its render exists.
    if (agent && input.run_in_background) return { behavior: "deny" as const, message: "Run this in the foreground and wait for it. Don't report back until the clip exists." };
    if (name === "Agent" || name === "Task") {
      const rt = this.runtimes.get(id);
      const verdict = checkAgent(input, !!rt && (rt.spawning || rt.motion.size > 0));
      if (verdict.behavior === "deny") return { behavior: "deny" as const, message: verdict.reason };
      if (rt) rt.spawning = true;
      return { behavior: "allow" as const, updatedInput: input };
    }
    if (name === "AskUserQuestion") {
      const answer = (await this.ask(id, "question", input, signal)) as { answers?: unknown; response?: string } | null;
      if (!answer) return { behavior: "deny" as const, message: "No answer was given." };
      return { behavior: "allow" as const, updatedInput: { questions: input.questions, answers: answer.answers ?? {}, ...(answer.response ? { response: answer.response } : {}) } };
    }
    const isolation = this.deps.isolation?.(chat) ?? null;
    const roots = isolation?.roots ?? [PLUGIN_DIR, DIRS.library, DIRS.files, DIRS.cache];
    const verdict = checkTool(name, input, chat.cwd, allowed, roots);
    // With approvals off, for this person or this chat, only the original footage still asks.
    const off = this.db.setting(`c:${id}:approvals`) === "off" || (!!chat.owner_id && this.db.setting(`m:${chat.owner_id}:approvals`) === "off");
    if (off && verdict.behavior === "ask" && !verdict.footage) return { behavior: "allow" as const, updatedInput: input };
    // On a Hub, other people's footage and the studio's own data are never one click away.
    const target = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
    if (isolation && verdict.behavior === "ask" && name !== "Bash" && target && inside(target, HOME)) return { behavior: "deny" as const, message: "That file belongs to the studio or to someone else. Use files from this mission." };
    if (verdict.behavior === "allow") return { behavior: "allow" as const, updatedInput: input };
    if (verdict.behavior === "deny") return { behavior: "deny" as const, message: verdict.reason };
    // The card says who is asking, what will happen in plain words, and what it touches.
    const subject = name === "Bash" ? verdict.subject ?? null : name;
    const about = { ...describeRequest(name, input), who: agent ? "The Motion agent" : chat.name, subject, footage: !!(verdict as { footage?: boolean }).footage };
    const answer = (await this.ask(id, "permission", { tool: name, input, reason: verdict.reason, about }, signal)) as { allow?: boolean; always?: boolean; all?: boolean } | null;
    if (!answer?.allow) return { behavior: "deny" as const, message: "The user said no to this." };
    if (answer.all) {
      this.db.setSetting(`c:${id}:approvals`, "off");
      this.allowPending({ chatId: id });
    }
    else if (answer.always && subject) {
      allowed.add(subject);
      this.db.setSetting(`c:${id}:allowed`, JSON.stringify([...allowed]));
    }
    return { behavior: "allow" as const, updatedInput: input };
  }

  /** Pauses the editor until a person answers. Used for questions and approvals. */
  ask(chatId: string, kind: string, payload: unknown, signal?: AbortSignal) {
    const id = randomUUID();
    this.db.run("INSERT INTO decisions (id, chat_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)", id, chatId, kind, JSON.stringify(payload), Date.now());
    const before = this.row(chatId);
    this.status(chatId, { status: "needs", detail: kind === "permission" ? "Needs your approval" : "Needs your pick" });
    this.bus.emit("decision", { id, chatId, kind, payload });
    return new Promise<unknown>((resolve) => {
      const finish = (answer: unknown) => {
        this.pending.delete(id);
        this.status(chatId, { status: "working", detail: before.detail });
        resolve(answer);
      };
      this.pending.set(id, { resolve: finish, chatId });
      signal?.addEventListener("abort", () => {
        this.db.run("UPDATE decisions SET status = 'expired' WHERE id = ?", id);
        this.bus.emit("decision.closed", { id, chatId });
        finish(null);
      }, { once: true });
    });
  }

  /**
   * Allows the approval cards already waiting, once approvals are turned off for a chat or a
   * person. A card about the original footage keeps waiting for a real answer.
   */
  allowPending(where: { chatId?: string; ownerId?: string }) {
    const rows = this.db.all<{ id: string; payload: string }>(
      "SELECT d.id, d.payload FROM decisions d JOIN chats c ON c.id = d.chat_id WHERE d.kind = 'permission' AND d.status = 'open' AND (? IS NULL OR d.chat_id = ?) AND (? IS NULL OR c.owner_id = ?)",
      where.chatId ?? null, where.chatId ?? null, where.ownerId ?? null, where.ownerId ?? null,
    );
    for (const r of rows) {
      if (json<{ about?: { footage?: boolean } }>(r.payload, {}).about?.footage) continue;
      if (this.pending.has(r.id)) this.answer(r.id, { allow: true });
    }
  }

  answer(decisionId: string, answer: unknown) {
    const p = this.pending.get(decisionId);
    if (!p) throw new Error("That question has already been closed.");
    this.db.run("UPDATE decisions SET status = 'answered', answer = ? WHERE id = ?", JSON.stringify(answer), decisionId);
    this.bus.emit("decision.closed", { id: decisionId, chatId: p.chatId, answer });
    p.resolve(answer);
  }

  async interrupt(id: string) {
    const rt = this.runtimes.get(id);
    for (const task of rt?.motion ?? []) await rt?.q.stopTask(task).catch(() => {});
    rt?.motion.clear();
    await rt?.q.interrupt().catch(() => {});
    this.status(id, { status: "idle", detail: "" });
  }

  close(id: string) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.runtimes.delete(id);
    if (rt.idle) clearTimeout(rt.idle);
    rt.input.close();
    rt.q.close();
  }

  end(id: string) {
    for (const c of this.db.all<{ id: string }>("SELECT id FROM chats WHERE parent_id = ? AND ended_at IS NULL", id)) this.end(c.id);
    this.close(id);
    for (const [decision, p] of this.pending) if (p.chatId === id) p.resolve(null), this.pending.delete(decision);
    this.db.run("UPDATE chats SET ended_at = ?, status = 'idle' WHERE id = ?", Date.now(), id);
    this.bus.emit("chat.ended", { id });
  }

  stop() {
    for (const id of [...this.runtimes.keys()]) this.close(id);
  }

  /** When someone leaves the studio, their editors stop at once. Their chats stay for admins to see. */
  closeOwner(ownerId: string) {
    for (const r of this.db.all<{ id: string }>("SELECT id FROM chats WHERE owner_id = ? AND ended_at IS NULL", ownerId)) {
      for (const [decision, p] of this.pending) if (p.chatId === r.id) p.resolve(null), this.pending.delete(decision);
      this.close(r.id);
      this.db.run("UPDATE chats SET status = 'idle', detail = '' WHERE id = ?", r.id);
    }
  }

  get busy() {
    return this.db.get<{ n: number }>("SELECT COUNT(*) n FROM chats WHERE ended_at IS NULL AND status IN ('working', 'thinking')")!.n;
  }
}

/** Bookkeeping calls move the editor around but aren't worth showing as activity. */
const QUIET = /__(set_stage|log_call)$|^(TodoWrite|ToolSearch)$/;

const LABELS: Record<string, string> = {
  open_footage: "Opening the footage", get_edit_doc: "Reading the transcript", analyze_takes: "Finding retakes and fillers", edit_ops: "Changing the edit", restore_version: "Restoring a version",
  render_preview: "Rendering a preview", render_final: "Rendering the final video", view_frames: "Checking frames", search_broll: "Searching B-roll", browse_library: "Browsing the library",
  view_filmstrip: "Looking at a shot", find_similar: "Finding similar shots", use_clip: "Placing B-roll", log_choice: "Noting a rejected shot", remove_background: "Removing the background",
  brief_motion_agent: "Cutting a section for the Motion agent", check_motion: "Checking the motion", list_fonts: "Choosing a font", reframe: "Reframing", parallax: "Building a 3D camera move", track_camera: "Tracking the camera", measure_reference: "Measuring the reference", list_free_sfx: "Browsing sound effects", ask_choice: "Asking you to pick",
};

export function toolLabel(tool: string, input: Record<string, unknown>) {
  const named = LABELS[tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "")];
  if (named) return named;
  if (tool.startsWith("mcp__earshot__")) return "Listening to the audio";
  if (tool.startsWith("mcp__epidemic__")) return "Searching Epidemic Sound";
  if (tool.startsWith("mcp__envato__")) return "Searching Envato Elements";
  const short = tool.replace(/^mcp__/, "").replace(/__/g, " ");
  if (tool === "Agent" || tool === "Task") return "Briefing the Motion agent";
  if (tool === "Bash") return String(input.description ?? "Running a command").slice(0, 80);
  if (tool === "Read") return `Reading ${basename(String(input.file_path ?? ""))}`;
  if (tool === "Write" || tool === "Edit") return `Writing ${basename(String(input.file_path ?? ""))}`;
  if (tool === "Skill") return `Using ${String(input.skill ?? input.command ?? "a skill").replace(/^shifu-dojo:/, "").replace(/-/g, " ")} skill`;
  return short.replace(/_/g, " ");
}
