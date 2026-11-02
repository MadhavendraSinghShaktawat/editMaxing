import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync, existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, McpServerConfig, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Bus } from "../bus.ts";
import { DIRS, MOTION_MODULES, MOTION_PYTHON, PLUGIN_DIR } from "../config.ts";
import { MOTION_AGENT } from "../prompt.ts";
import type { Database } from "../db.ts";
import { json } from "../db.ts";
import { AsyncQueue } from "../lib/dsa.ts";
import type { Accounts } from "./accounts.ts";
import { checkAgent, checkTool } from "./policy.ts";

export type Station = "library" | "cutting" | "animation" | "captions" | "living" | "sound" | "render" | "review";
export type ChatStatus = "idle" | "working" | "thinking" | "needs" | "stuck" | "resting";

export type ChatRow = {
  id: string; name: string; look: number; account_id: string; model: string; effort: string | null; session_id: string | null;
  cwd: string; status: ChatStatus; detail: string; station: Station; stage: string | null; mission: string | null; cost: number;
  created_at: number; updated_at: number; ended_at: number | null;
};

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
export type Brief = { title?: string; modeId?: string | null; styleId?: string | null; reason?: string; locale?: string };

type Pending = { resolve: (answer: unknown) => void; chatId: string };

type Runtime = { q: Query; input: AsyncQueue<SDKUserMessage>; idle: NodeJS.Timeout | null; allowed: Set<string>; motion: Set<string>; spawning: boolean };

export type ChatDeps = {
  mcp: (chat: ChatRow) => Promise<Record<string, McpServerConfig>>;
  prompt: (chat: ChatRow) => string;
  env?: () => Promise<Record<string, string>>;
  onCorrection?: (chat: ChatRow, text: string) => void;
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
    // Nothing can still be running after a restart. Unanswered questions were asked by a dead process.
    db.run("UPDATE chats SET status = 'idle', detail = '' WHERE status IN ('working', 'thinking', 'needs')");
    db.run("UPDATE decisions SET status = 'expired' WHERE status = 'open'");
  }

  row(id: string) {
    const r = this.db.get<ChatRow>("SELECT * FROM chats WHERE id = ?", id);
    if (!r) throw new Error("That chat no longer exists.");
    return r;
  }

  view(r: ChatRow) {
    return { id: r.id, name: r.name, look: r.look, accountId: r.account_id, model: r.model, effort: r.effort, status: r.status, detail: r.detail, station: r.station, stage: r.stage, mission: json(r.mission, null), cost: r.cost, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  list() {
    return this.db.all<ChatRow>("SELECT * FROM chats WHERE ended_at IS NULL ORDER BY created_at").map((r) => this.view(r));
  }

  messages(id: string) {
    return this.db.all<{ id: number; role: string; kind: string; text: string; data: string | null; created_at: number }>("SELECT * FROM messages WHERE chat_id = ? ORDER BY id", id).map((m) => ({ id: m.id, role: m.role, kind: m.kind, text: m.text, data: json(m.data, null), createdAt: m.created_at }));
  }

  openDecisions(id?: string) {
    const rows = id ? this.db.all<{ id: string; chat_id: string; kind: string; payload: string }>("SELECT * FROM decisions WHERE status = 'open' AND chat_id = ?", id) : this.db.all<{ id: string; chat_id: string; kind: string; payload: string }>("SELECT * FROM decisions WHERE status = 'open'");
    return rows.map((d) => ({ id: d.id, chatId: d.chat_id, kind: d.kind, payload: json(d.payload, {}) }));
  }

  create(options: { accountId?: string; model?: string; effort?: string; brief?: Brief }) {
    const open = this.db.all<{ name: string }>("SELECT name FROM chats WHERE ended_at IS NULL").map((r) => r.name);
    if (open.length >= MAX_CHATS) throw new Error("Your studio is full. End a chat to make room.");
    const [name, look] = NAMES.find(([n]) => !open.includes(n))!;
    const account = this.accounts.get(options.accountId ?? this.db.setting("account") ?? "default");
    if (!account.signedIn) throw new Error(`${account.label} isn't signed in yet.`);
    const id = randomUUID();
    const cwd = join(DIRS.missions, id);
    for (const dir of ["inputs", "work", "out", "motion"]) mkdirSync(join(cwd, dir), { recursive: true });
    if (existsSync(MOTION_MODULES)) symlinkSync(MOTION_MODULES, join(cwd, "motion/node_modules"));
    const now = Date.now();
    const model = options.model ?? this.db.setting("model") ?? "sonnet";
    const effort = options.effort ?? this.db.setting("effort") ?? "medium";
    this.db.run("INSERT INTO chats (id, name, look, account_id, model, effort, cwd, mission, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, name, look, account.id, model, effort, cwd, JSON.stringify(options.brief ?? {}), now, now);
    const view = this.view(this.row(id));
    this.bus.emit("chat", view);
    return view;
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
    this.db.run("UPDATE chats SET model = ?, effort = ? WHERE id = ?", model, effort, id);
    this.db.setSetting("model", model);
    if (effort) this.db.setSetting("effort", effort);
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
    this.accounts.get(accountId);
    this.db.run("UPDATE chats SET account_id = ? WHERE id = ?", accountId, id);
    this.db.setSetting("account", accountId);
    this.bus.emit("chat", this.view(this.row(id)));
  }

  async send(id: string, text: string, attachments: { hash: string; name: string; role: string; path: string; kind: string; duration?: number }[] = []) {
    const chat = this.row(id);
    const brief = json<Brief>(chat.mission, {});
    const replying = this.db.get("SELECT id FROM messages WHERE chat_id = ? AND role = 'user' LIMIT 1", id);
    if (replying && !text.startsWith("/")) this.deps.onCorrection?.(chat, text);
    const lines: string[] = [];
    for (const a of attachments) {
      const safe = basename(a.name).replace(/[^\w.\- ]+/g, "_");
      const link = join(chat.cwd, "inputs", `${a.hash.slice(0, 8)}-${safe}`);
      if (!existsSync(link)) symlinkSync(a.path, link);
      lines.push(`- inputs/${basename(link)} (${a.role}${a.duration ? `, ${a.duration.toFixed(1)}s` : ""})`);
    }
    this.message(id, "user", "text", text, attachments.length ? { attachments } : undefined);
    if (!brief.title && (text.trim() || attachments.length)) {
      this.status(id, { mission: { ...brief, title: text.trim().slice(0, 60) || attachments[0].name.replace(/\.[^.]+$/, "") } });
    }
    const content = lines.length ? `${text}\n\nAttached files:\n${lines.join("\n")}` : text;
    const rt = await this.ensure(id);
    this.status(id, { status: "thinking", detail: "Reading your note" });
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
    const allowed = new Set<string>();
    const canUseTool: CanUseTool = (name, toolInput, options) => this.permission(id, name, toolInput, options.signal, allowed, options.agentID);
    const account = await this.accounts.options(chat.account_id);
    const q = query({
      prompt: input,
      options: {
        ...account,
        // Renders and first-run model loads take far longer than a normal tool call.
        env: { ...account.env, ...(await this.deps.env?.()), PATH: `${MOTION_PYTHON}${delimiter}${account.env?.PATH}`, MCP_TIMEOUT: "60000", MCP_TOOL_TIMEOUT: "3600000", DOJO_MOTION_KIT: join(PLUGIN_DIR, "skills/motion-broll"), BASH_DEFAULT_TIMEOUT_MS: "1800000", BASH_MAX_TIMEOUT_MS: "3600000" },
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
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.deps.prompt(chat) },
      },
    });
    const rt: Runtime = { q, input, idle: null, allowed, motion: new Set(), spawning: false };
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
        else if (m.subtype === "task_started" && m.subagent_type === "motion") {
          rt.motion.add(m.task_id);
          rt.spawning = false;
          this.message(id, "editor", "tool", "The Motion agent started building", { tool: "Agent" });
        } else if (m.subtype === "task_notification" && rt.motion.delete(m.task_id)) {
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
        if (m.parent_tool_use_id) break;
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
          this.accounts.noteRateLimit(this.row(id).account_id);
          break;
        }
        this.status(id, { status: m.subtype === "success" ? "idle" : "stuck", detail: m.subtype === "success" ? "" : "Stopped", cost: m.total_cost_usd });
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
    const verdict = checkTool(name, input, chat.cwd, allowed, [PLUGIN_DIR, DIRS.library, DIRS.files, DIRS.cache]);
    if (verdict.behavior === "allow") return { behavior: "allow" as const, updatedInput: input };
    if (verdict.behavior === "deny") return { behavior: "deny" as const, message: verdict.reason };
    const answer = (await this.ask(id, "permission", { tool: name, input, reason: verdict.reason }, signal)) as { allow?: boolean; always?: boolean } | null;
    if (!answer?.allow) return { behavior: "deny" as const, message: "The user said no to this." };
    if (answer.always) allowed.add(name === "Bash" ? String(input.command ?? "").trim().split(/\s+/)[0] : name);
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
    this.close(id);
    for (const [decision, p] of this.pending) if (p.chatId === id) p.resolve(null), this.pending.delete(decision);
    this.db.run("UPDATE chats SET ended_at = ?, status = 'idle' WHERE id = ?", Date.now(), id);
    this.bus.emit("chat.ended", { id });
  }

  stop() {
    for (const id of [...this.runtimes.keys()]) this.close(id);
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
  const short = tool.replace(/^mcp__/, "").replace(/__/g, " ");
  if (tool === "Agent" || tool === "Task") return "Briefing the Motion agent";
  if (tool === "Bash") return String(input.description ?? "Running a command").slice(0, 80);
  if (tool === "Read") return `Reading ${basename(String(input.file_path ?? ""))}`;
  if (tool === "Write" || tool === "Edit") return `Writing ${basename(String(input.file_path ?? ""))}`;
  if (tool === "Skill") return `Using ${String(input.skill ?? input.command ?? "a skill").replace(/^shifu-dojo:/, "").replace(/-/g, " ")} skill`;
  return short.replace(/_/g, " ");
}
