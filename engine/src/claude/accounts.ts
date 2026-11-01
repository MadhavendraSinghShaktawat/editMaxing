import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo, Options } from "@anthropic-ai/claude-agent-sdk";
import type { Bus } from "../bus.ts";
import { DIRS, TOOL_PATH, findBin } from "../config.ts";
import type { Database } from "../db.ts";
import { json } from "../db.ts";
import { run } from "../lib/proc.ts";
import { secrets } from "../lib/secrets.ts";

export type LimitWindow = { id: string; label: string; kind: "session" | "weekly" | "model"; usedPercent: number; resetsAt: string | null };

export type Account = {
  id: string;
  label: string;
  kind: "subscription" | "api_key";
  configDir: string | null;
  email: string | null;
  plan: string | null;
  signedIn: boolean;
  models: ModelOption[];
  limits: LimitWindow[];
  limitsAt: number | null;
};

export type ModelOption = { id: string; name: string; description: string; resolved: string | null; efforts: string[]; fable: boolean };

type Row = { id: string; label: string; kind: string; config_dir: string | null; email: string | null; plan: string | null; signed_in: number; models: string | null; limits: string | null; limits_at: number | null };

const never = () =>
  (async function* () {
    await new Promise(() => {});
  })();

export function claudePath() {
  const p = findBin("claude");
  if (!p) throw new Error("Claude Code is not installed. Install it, then sign in.");
  return p;
}

/** Turns the /usage payload into plain windows. Field names come from the live response. */
export function parseLimits(rateLimits: unknown): LimitWindow[] {
  const r = (rateLimits ?? {}) as {
    limits?: { kind: string; percent: number | null; resets_at: string | null; scope?: { model?: { display_name?: string } } | null }[];
    five_hour?: { utilization: number | null; resets_at: string | null } | null;
    seven_day?: { utilization: number | null; resets_at: string | null } | null;
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
  };
  const out: LimitWindow[] = [];
  if (Array.isArray(r.limits) && r.limits.length) {
    for (const l of r.limits) {
      const usedPercent = l.percent ?? 0;
      if (l.kind === "session") out.push({ id: "session", label: "5-hour session", kind: "session", usedPercent, resetsAt: l.resets_at });
      else if (l.kind === "weekly_all") out.push({ id: "weekly", label: "Weekly", kind: "weekly", usedPercent, resetsAt: l.resets_at });
      else if (l.kind === "weekly_scoped" && l.scope?.model?.display_name) {
        const name = l.scope.model.display_name;
        out.push({ id: `model:${name.toLowerCase()}`, label: name, kind: "model", usedPercent, resetsAt: l.resets_at });
      }
    }
    return out;
  }
  if (r.five_hour) out.push({ id: "session", label: "5-hour session", kind: "session", usedPercent: r.five_hour.utilization ?? 0, resetsAt: r.five_hour.resets_at });
  if (r.seven_day) out.push({ id: "weekly", label: "Weekly", kind: "weekly", usedPercent: r.seven_day.utilization ?? 0, resetsAt: r.seven_day.resets_at });
  for (const m of r.model_scoped ?? []) out.push({ id: `model:${m.display_name.toLowerCase()}`, label: m.display_name, kind: "model", usedPercent: m.utilization ?? 0, resetsAt: m.resets_at });
  return out;
}

const toModel = (m: ModelInfo): ModelOption => ({
  id: m.value,
  name: m.displayName,
  description: m.description,
  resolved: m.resolvedModel ?? null,
  efforts: m.supportedEffortLevels ?? [],
  fable: /fable/i.test(`${m.value} ${m.displayName} ${m.resolvedModel ?? ""}`),
});

export class Accounts {
  private db: Database;
  private bus: Bus;
  private probing = new Map<string, Promise<void>>();
  private lastEvent = new Map<string, number>();
  private logins = new Map<string, () => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Database, bus: Bus) {
    this.db = db;
    this.bus = bus;
  }

  async init() {
    if (!this.db.get("SELECT id FROM accounts WHERE id = 'default'")) {
      this.db.run("INSERT INTO accounts (id, label, config_dir, created_at) VALUES ('default', 'This Mac', NULL, ?)", Date.now());
    }
    await Promise.allSettled(this.list().map((a) => this.refresh(a.id)));
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const active = new Set(this.db.all<{ account_id: string }>("SELECT DISTINCT account_id FROM chats WHERE status IN ('working', 'thinking')").map((r) => r.account_id));
    for (const a of this.list()) {
      const age = Date.now() - (a.limitsAt ?? 0);
      if (a.signedIn && age > (active.has(a.id) ? 90_000 : 600_000)) void this.probe(a.id);
    }
  }

  private toAccount(r: Row): Account {
    return { id: r.id, label: r.label, kind: r.kind as Account["kind"], configDir: r.config_dir, email: r.email, plan: r.plan, signedIn: !!r.signed_in, models: json(r.models, []), limits: json(r.limits, []), limitsAt: r.limits_at };
  }

  list() {
    return this.db.all<Row>("SELECT * FROM accounts ORDER BY created_at").map((r) => this.toAccount(r));
  }

  get(id: string) {
    const r = this.db.get<Row>("SELECT * FROM accounts WHERE id = ?", id);
    if (!r) throw new Error("That account no longer exists.");
    return this.toAccount(r);
  }

  /** Each account is isolated by its own config directory. HOME stays intact so Keychain access works. */
  async env(id: string) {
    const a = this.get(id);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: TOOL_PATH };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDECODE;
    if (a.configDir) env.CLAUDE_CONFIG_DIR = a.configDir;
    if (a.kind === "api_key") {
      const key = await secrets.get(`account:${id}`);
      if (!key) throw new Error(`The API key for ${a.label} is missing. Add it again.`);
      env.ANTHROPIC_API_KEY = key;
    }
    return env;
  }

  async options(id: string): Promise<Pick<Options, "env" | "pathToClaudeCodeExecutable">> {
    return { env: await this.env(id), pathToClaudeCodeExecutable: claudePath() };
  }

  create(label: string, kind: Account["kind"]) {
    const id = randomUUID();
    const configDir = join(DIRS.accounts, id);
    mkdirSync(configDir, { recursive: true });
    this.db.run("INSERT INTO accounts (id, label, config_dir, kind, created_at) VALUES (?, ?, ?, ?, ?)", id, label, configDir, kind, Date.now());
    this.emit(id);
    return this.get(id);
  }

  async addApiKey(label: string, key: string) {
    const a = this.create(label, "api_key");
    await secrets.set(`account:${a.id}`, key);
    await this.refresh(a.id);
    return this.get(a.id);
  }

  /**
   * Runs Claude's own sign-in. The browser flow belongs to Claude Code; Dojo only relays
   * the sign-in link and never sees a token.
   */
  async login(id: string, mode: "claudeai" | "console" = "claudeai") {
    const account = this.get(id);
    this.logins.get(id)?.();
    const child = spawn(claudePath(), ["auth", "login", `--${mode}`], { env: await this.env(id), stdio: ["pipe", "pipe", "pipe"] });
    this.logins.set(id, () => child.kill("SIGTERM"));
    this.bus.emit("account.login", { id, status: "started", label: account.label });
    const scan = (chunk: Buffer) => {
      const url = chunk.toString("utf8").match(/https:\/\/\S+/)?.[0];
      if (url) this.bus.emit("account.login", { id, status: "link", url });
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("close", (code) => {
      this.logins.delete(id);
      void this.refresh(id).then(() => this.bus.emit("account.login", { id, status: code === 0 ? "done" : "failed" }));
    });
  }

  cancelLogin(id: string) {
    this.logins.get(id)?.();
  }

  async logout(id: string) {
    await run(claudePath(), ["auth", "logout"], { env: await this.env(id) });
    await this.refresh(id);
  }

  async remove(id: string) {
    const a = this.get(id);
    if (id === "default") throw new Error("This Mac's own Claude login can't be removed here.");
    const used = this.db.get<{ n: number }>("SELECT COUNT(*) n FROM chats WHERE account_id = ? AND ended_at IS NULL", id)!.n;
    if (used) throw new Error(`End the ${used} open chat${used > 1 ? "s" : ""} on this account first.`);
    if (a.kind === "subscription") await run(claudePath(), ["auth", "logout"], { env: await this.env(id) }).catch(() => {});
    await secrets.remove(`account:${id}`);
    const dir = a.configDir && resolve(a.configDir);
    if (dir?.startsWith(resolve(DIRS.accounts) + sep)) rmSync(dir, { recursive: true, force: true });
    this.db.run("DELETE FROM chats WHERE account_id = ?", id);
    this.db.run("DELETE FROM accounts WHERE id = ?", id);
    this.bus.emit("account.removed", { id });
  }

  async refresh(id: string) {
    const a = this.get(id);
    try {
      const { stdout } = await run(claudePath(), ["auth", "status"], { env: await this.env(id) }).catch((e: { message: string }) => ({ stdout: e.message }));
      const s = json<{ loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string }>(stdout, {});
      const signedIn = a.kind === "api_key" ? true : !!s.loggedIn;
      this.db.run("UPDATE accounts SET signed_in = ?, email = ?, plan = ? WHERE id = ?", signedIn ? 1 : 0, s.email ?? null, s.subscriptionType ?? (a.kind === "api_key" ? "api" : null), id);
      if (signedIn) await this.probe(id);
    } finally {
      this.emit(id);
    }
  }

  /** Reads limits and models over a local control channel. This makes no model call. */
  probe(id: string) {
    const running = this.probing.get(id);
    if (running) return running;
    const work = (async () => {
      const q = query({ prompt: never(), options: { ...(await this.options(id)), settingSources: [], persistSession: false, tools: [], cwd: DIRS.tmp } });
      try {
        const [models, usage] = await Promise.all([q.supportedModels(), q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })]);
        const limits = usage.rate_limits_available ? parseLimits(usage.rate_limits) : [];
        this.db.run("UPDATE accounts SET models = ?, limits = ?, limits_at = ? WHERE id = ?", JSON.stringify(models.map(toModel)), JSON.stringify(limits), Date.now(), id);
      } finally {
        q.close();
      }
      this.emit(id);
    })().finally(() => this.probing.delete(id));
    this.probing.set(id, work);
    return work;
  }

  /** Chats report limit changes as they happen. Re-reading is throttled per account. */
  noteRateLimit(id: string) {
    const last = this.lastEvent.get(id) ?? 0;
    if (Date.now() - last < 30_000) return;
    this.lastEvent.set(id, Date.now());
    void this.probe(id).catch(() => {});
  }

  session(id: string) {
    return this.get(id).limits.find((l) => l.kind === "session") ?? null;
  }

  private emit(id: string) {
    this.bus.emit("account", this.get(id));
  }
}
