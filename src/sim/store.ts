import { useEffect, useReducer } from "react";
import { DOCK, Facing, STATIONS, Spot, StationId } from "../world/layout";
import { findPath } from "../world/nav";
import { Pose } from "../world3d/types";
import { BROLL_PROMPTS, CHAT_NAMES, CREW_SEED, Mission, QUEUED_MISSIONS, STAGES, StageId, Thumb } from "./data";
import { Account, Brief, ContextUsage, ChatStatus, ChatView, Client, Colleague, EngineDecision, EngineMessage, EngineStyle, EventType, Job, MotionItem, LibraryStats, LibraryView, Me, MemoryRule, Pack, Recipe, State, Studio, api, connect, leftOf } from "./engine";

export type Activity = "working" | "walking" | "thinking" | "needs" | "coffee" | "chatting" | "celebrating" | "resting" | "stuck" | "waiting";

export type Decision = {
  id: string;
  prompt: string;
  at: string;
  options: { id: string; label: string; why: string; scene: Thumb }[];
  chosen?: string;
};

export type Message = {
  id: number;
  from: "editor" | "user" | "system";
  text: string;
  tool?: string;
  decision?: Decision;
  attachments?: Attachment[];
  video?: { url: string; quality?: { pass: boolean; checks: { name: string; ok: boolean; detail: string }[] } | null; srt?: string | null; fcpxml?: string | null };
  error?: boolean;
  /** A lesson memory wants to keep, waiting for one tap. */
  memory?: { ruleId: string; clientId: string | null };
  /** On "started the Motion agent": the agent's own chat, to watch it. */
  childId?: string;
  /** A context compaction, shown as a divider: running, then the tokens before and after. */
  compaction?: { status: "running" | "done" | "failed"; before?: number; after?: number; error?: string };
};

export type Attachment = {
  id: string;
  name: string;
  kind: "video" | "image" | "file";
  role: "reference" | "footage" | "file";
  size: number;
  duration?: number;
  thumb?: string;
  hash?: string;
  /** What a reference is for: editing, motion, explainer, captions, sound. None means all of it. */
  tags?: string[];
};

export type Editor = {
  id: string;
  name: string;
  role: string;
  look: number;
  mission: Mission | null;
  stage: number;
  stageProgress: number;
  overall: number;
  activity: Activity;
  detail: string;
  x: number;
  y: number;
  face: Facing;
  pose: Pose;
  anim: number;
  path: [number, number][];
  spot: Spot | null;
  station: StationId;
  timer: number;
  after: Activity | "resume" | "leave";
  decided: number;
  decisionOpen: Decision | null;
  messages: Message[];
  hue: number;
  version: number;
  thought: number;
  model: string;
  effort: string;
  accountId: string;
  draft: string;
  status: ChatStatus;
  loaded: boolean;
  questions: EngineDecision[];
  started: boolean;
  /** The last context-window reading, for the meter and the Compact chip. */
  context?: ContextUsage | null;
  /** Set when another chat started this agent. Such a chat is read-only. */
  parentId?: string | null;
};

export const MAX_EDITORS = 8;

const ACTIVITY: Record<ChatStatus, Activity> = { idle: "waiting", working: "working", thinking: "thinking", needs: "needs", stuck: "stuck", resting: "resting" };
const STAGE_INDEX: Record<string, number> = { cutting: 1, broll: 2, captions: 3, graphics: 4, sound: 5, review: 7 };
const POSE: Partial<Record<StationId, Pose>> = { library: "read", render: "watch", review: "watch" };

export type Theme = "day" | "evening" | "night";
export const THEME_HOURS: Record<Theme, number> = { day: 12.5, evening: 18.1, night: 21.5 };

function initialTheme(): Theme {
  const asked = new URLSearchParams(location.search).get("theme");
  const saved = asked ?? localStorage.getItem("dojo.theme");
  if (saved === "day" || saved === "evening" || saved === "night") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

const uid = (() => {
  let n = 0;
  return () => ++n;
})();

class Store {
  editors: Editor[] = [];
  selectedId: string | null = null;
  usage = { session: 0.68, weekly: 0.54, fable: 0.81, sessionResetMin: 134, weeklyResetMin: 2880, fableResetMin: 4320 };
  theme: Theme = initialTheme();
  clock = THEME_HOURS[this.theme];
  boat: { state: "away" | "arriving" | "docked" | "leaving"; x: number; timer: number; passenger: Editor | null } = {
    state: "away",
    x: 840,
    timer: 12,
    passenger: null,
  };
  toast: { text: string; id: number } | null = null;
  reviewId: string | null = null;
  minutesSaved = 1284;
  shipped = 37;
  lastModel = { model: "sonnet", effort: "medium" };
  /** With ?demo the world runs on sample data. Otherwise everything comes from the engine. */
  live = !new URLSearchParams(location.search).has("demo");
  online = false;
  accounts: Account[] = [];
  motion: MotionItem[] = [];
  /** Bumped when the Motion library or its taxonomy changes, so open boards reload. */
  motionVersion = 0;
  styles: EngineStyle[] = [];
  recipes: Recipe[] = [];
  memory: MemoryRule[] = [];
  memoryAreas: string[] = [];
  me: Me | null = null;
  studio: Studio = { mode: "single", hubOrigin: null, joinedHub: null, closingAt: null };
  members: Colleague[] = [];
  clients: Client[] = [];
  libraries: LibraryView[] = [];
  /** Bumps when something on the Team side changes, so open admin screens reload. */
  teamVersion = 0;
  packs: Pack[] = [];
  keys: Record<string, boolean> = {};
  library: LibraryStats | null = null;
  jobs = new Map<string, Job>();
  private jobWaiters = new Map<string, Set<(j: Job) => void>>();

  /**
   * Follows a background job to its end, reporting progress on the way. A job that already
   * finished, even before a restart, is read back from the engine instead of waited on.
   */
  waitJob<T = unknown>(id: string, onProgress?: (j: Job) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const settle = (j: Job) => {
        if (j.status === "done") (done(), resolve(j.result as T));
        else if (j.status === "failed" || j.status === "cancelled") (done(), reject(new Error(j.error ?? "That didn't finish.")));
        else onProgress?.(j);
      };
      const set = this.jobWaiters.get(id) ?? new Set<(j: Job) => void>();
      const done = () => {
        set.delete(settle);
        if (!set.size) this.jobWaiters.delete(id);
      };
      set.add(settle);
      this.jobWaiters.set(id, set);
      const known = this.jobs.get(id);
      if (known && known.status !== "queued" && known.status !== "running") return settle(known);
      void api<Job[]>("GET", "/api/jobs").then((list) => {
        const j = list.find((x) => x.id === id);
        if (j) settle(j);
        else (done(), reject(new Error("That download is no longer running. Add it again.")));
      }).catch(() => {});
    });
  }
  settings: State["settings"] = { account: "default", model: "sonnet", effort: "medium", embedModel: "", usageCeiling: 85 };
  login: { id: string; status: string; url?: string; label?: string } | null = null;
  pendingDraft: string | null = null;
  private names = [...CHAT_NAMES];
  private queue: Mission[] = [];
  private listeners = new Set<() => void>();
  private lastNotify = 0;

  constructor() {
    const session = Number(new URLSearchParams(location.search).get("session"));
    if (session > 0 && session <= 1) this.usage.session = session;
    applyTheme(this.theme);
    if (this.live) void this.boot();
    else this.seedDemo();
  }

  private async boot() {
    connect((type, data) => this.onEvent(type, data), () => void this.refresh(), () => {
      this.online = false;
      this.emit();
    });
  }

  /** Reloads the Motion library and styles, whose thumbnails come from it. */
  async refreshMotion() {
    await this.refresh();
    this.motionVersion++;
    this.emit();
  }

  /** Runs on every connect, so a reconnect also heals anything missed while offline. */
  async refresh() {
    try {
      const s = await api<State>("GET", "/api/state");
      this.online = true;
      this.accounts = s.accounts;
      this.motion = s.motion ?? [];
      this.styles = s.styles;
      this.recipes = s.recipes;
      this.memory = s.memory;
      this.memoryAreas = s.memoryAreas;
      this.me = s.me;
      this.studio = s.studio;
      this.members = s.members;
      this.clients = s.clients;
      this.libraries = s.libraries;
      this.packs = s.packs;
      this.keys = s.keys;
      this.library = s.library;
      this.settings = s.settings;
      this.lastModel = { model: s.settings.model, effort: s.settings.effort };
      for (const j of s.jobs) this.jobs.set(j.id, j);
      const known = new Set(s.chats.map((c) => c.id));
      for (const e of this.editors) if (!known.has(e.id) && e.after !== "leave") this.dismiss(e);
      for (const c of s.chats) this.syncChat(c);
      for (const e of this.editors) e.questions = s.decisions.filter((d) => d.chatId === e.id);
      if (this.selectedId) await this.loadMessages(this.selectedId);
      this.syncUsage();
      this.emit();
    } catch {
      this.online = false;
      this.emit();
    }
  }

  /** The account whose limits show in the top bar: the open chat's, or the default. */
  activeAccount() {
    const id = this.selected()?.accountId ?? this.settings.account;
    return this.accounts.find((a) => a.id === id) ?? this.accounts[0] ?? null;
  }

  modelsFor(accountId?: string) {
    return (this.accounts.find((a) => a.id === accountId) ?? this.activeAccount())?.models ?? [];
  }

  private syncUsage() {
    const limits = this.activeAccount()?.limits ?? [];
    const minutes = (iso: string | null | undefined) => (iso ? Math.max(0, (new Date(iso).getTime() - Date.now()) / 60000) : 0);
    const session = limits.find((l) => l.kind === "session");
    const weekly = limits.find((l) => l.kind === "weekly");
    const fable = limits.find((l) => l.id === "model:fable");
    this.usage = { session: leftOf(session) ?? 1, weekly: leftOf(weekly) ?? 1, fable: leftOf(fable) ?? 1, sessionResetMin: minutes(session?.resetsAt), weeklyResetMin: minutes(weekly?.resetsAt), fableResetMin: minutes(fable?.resetsAt) };
  }

  private missionOf(c: ChatView): Mission | null {
    const brief = (c.mission ?? {}) as Brief;
    if (!brief.title) return null;
    const style = this.styles.find((v) => v.id === brief.styleId)?.name ?? "Default";
    return { title: brief.title, style, length: "--:--" };
  }

  private syncChat(c: ChatView) {
    let e = this.editors.find((v) => v.id === c.id);
    if (!e) {
      e = this.makeEditor(c.name, "All-round editor", c.look, null, 392, 428);
      e.id = c.id;
      this.names = this.names.filter((n) => n.name !== c.name);
      this.editors.push(e);
      this.walkTo(e, "living", "waiting", 12 + Math.random() * 10);
    }
    const wasReview = e.stage === 7;
    e.mission = this.missionOf(c);
    e.model = c.model;
    e.effort = c.effort ?? "";
    e.context = c.context ?? null;
    e.parentId = c.parentId ?? null;
    e.accountId = c.accountId;
    e.status = c.status;
    if (c.stage) e.stage = STAGE_INDEX[c.stage] ?? e.stage;
    if (c.station === "render" && c.status === "working") e.stage = 6;
    e.overall = e.stage / (STAGES.length - 1);
    if (c.status !== "idle") e.detail = c.detail || STAGES[e.stage].verb;
    if (c.status === "idle" && e.stage === 7 && !wasReview) {
      e.activity = "celebrating";
      e.timer = 3;
      this.walkTo(e, "review", "celebrating", 3);
      e.detail = "Ready for review";
      return;
    }
    const station = c.station as StationId;
    if (c.status !== "idle" && station !== e.station && STATIONS[station]) this.walkTo(e, station, "working");
    else if (!e.path.length && c.status !== "idle") e.activity = ACTIVITY[c.status];
    else if (c.status === "idle" && (e.activity === "working" || e.activity === "thinking" || e.activity === "stuck" || e.activity === "needs")) {
      e.activity = "waiting";
      e.timer = e.stage === 7 ? 9999 : 8 + Math.random() * 10;
      e.detail = e.stage === 7 ? "Ready for review" : "Wandering the villa";
    }
  }

  private toMessage(m: EngineMessage, chatId: string): Message {
    const d = m.data ?? {};
    const from = m.role === "user" ? "user" : m.role === "system" ? "system" : "editor";
    const out: Message = { id: m.id, from, text: m.text };
    if (m.kind === "tool") out.tool = m.text;
    if (typeof d.childId === "string") out.childId = d.childId;
    if (m.kind === "memory.suggest" && typeof d.ruleId === "string") out.memory = { ruleId: d.ruleId, clientId: (d.clientId as string | null) ?? null };
    if (m.kind === "error") out.error = true;
    if (m.kind === "compaction") out.compaction = d as NonNullable<Message["compaction"]>;
    if (m.kind === "video") {
      const name = String(d.path ?? "").split("/").pop() ?? "";
      const part = (p: unknown) => (p ? `/api/chats/${chatId}/out/${encodeURIComponent(String(p).split("/").pop()!)}` : null);
      out.video = { url: `/api/chats/${chatId}/out/${encodeURIComponent(name)}`, quality: d.quality as NonNullable<Message["video"]>["quality"], srt: part(d.srt), fcpxml: part(d.fcpxml) };
    }
    const files = d.attachments as { hash: string; name: string; role: Attachment["role"]; kind: Attachment["kind"]; duration?: number }[] | undefined;
    if (files) out.attachments = files.map((f) => ({ id: f.hash, hash: f.hash, name: f.name, kind: f.kind, role: f.role, size: 0, duration: f.duration }));
    return out;
  }

  async loadMessages(id: string) {
    const r = await api<{ messages: EngineMessage[]; decisions: EngineDecision[] }>("GET", `/api/chats/${id}/messages`);
    const e = this.editors.find((v) => v.id === id);
    if (!e) return;
    e.messages = r.messages.map((m) => this.toMessage(m, id));
    e.questions = r.decisions;
    e.started = r.messages.length > 0;
    e.loaded = true;
    this.emit();
  }

  private onEvent(type: EventType, data: never) {
    const editor = (id: string) => this.editors.find((e) => e.id === id);
    switch (type) {
      case "chat":
        this.syncChat(data as ChatView);
        break;
      case "chat.ended": {
        const e = editor((data as { id: string }).id);
        if (e) this.dismiss(e);
        break;
      }
      case "message": {
        const m = data as EngineMessage & { chatId: string };
        const e = editor(m.chatId);
        if (!e) break;
        e.started = true;
        if (m.kind === "text" && m.role === "editor") e.draft = "";
        // A compaction row changes in place, from running to done.
        const at = e.messages.findIndex((v) => v.id === m.id);
        if (e.loaded && at >= 0 && (m as { amended?: boolean }).amended) e.messages[at] = this.toMessage(m, m.chatId);
        else if (e.loaded && at < 0) e.messages.push(this.toMessage(m, m.chatId));
        break;
      }
      case "delta": {
        const d = data as { chatId: string; text: string };
        const e = editor(d.chatId);
        if (e) e.draft = d.text;
        break;
      }
      case "decision": {
        const d = data as EngineDecision;
        editor(d.chatId)?.questions.push(d);
        break;
      }
      case "decision.closed": {
        const d = data as { id: string; chatId: string };
        const e = editor(d.chatId);
        if (e) e.questions = e.questions.filter((q) => q.id !== d.id);
        break;
      }
      case "account": {
        const a = data as Account;
        const i = this.accounts.findIndex((v) => v.id === a.id);
        if (i >= 0) this.accounts[i] = a;
        else this.accounts.push(a);
        this.syncUsage();
        break;
      }
      case "account.removed":
        this.accounts = this.accounts.filter((a) => a.id !== (data as { id: string }).id);
        break;
      case "account.login":
        this.login = data as NonNullable<Store["login"]>;
        break;
      case "job": {
        const j = data as Job;
        const merged = { ...this.jobs.get(j.id), ...j };
        this.jobs.set(j.id, merged);
        for (const w of this.jobWaiters.get(j.id) ?? []) w(merged);
        break;
      }
      case "library":
        // Counts depend on who's asking, so the event only says something changed.
        void this.attempt(async () => {
          const r = await api<{ stats: LibraryStats; libraries: LibraryView[] }>("GET", "/api/library");
          this.library = r.stats;
          this.libraries = r.libraries;
          this.emit();
        });
        break;
      case "library.warning":
        this.notify((data as { message: string }).message);
        break;
      case "style": {
        const v = data as EngineStyle;
        this.styles = [...this.styles.filter((o) => o.id !== v.id), v];
        break;
      }
      case "style.removed":
        this.styles = this.styles.filter((o) => o.id !== (data as { id: string }).id);
        break;
      case "motion": {
        // A whole harvest only says which style it came from, so the list is fetched again.
        const v = data as MotionItem | { styleId: string };
        if ("kind" in v) this.motion = [v, ...this.motion.filter((o) => o.id !== v.id)];
        else void this.refreshMotion();
        this.motionVersion++;
        break;
      }
      case "motion.removed":
        this.motion = this.motion.filter((o) => o.id !== (data as { id: string }).id);
        this.motionVersion++;
        break;
      case "motion.taxonomy":
        this.motionVersion++;
        break;
      case "recipe":
        this.recipes = [...this.recipes, data as Recipe];
        break;
      case "memory": {
        const rule = data as MemoryRule;
        this.memory = rule.status === "removed" || rule.status === "superseded" ? this.memory.filter((m) => m.id !== rule.id) : [rule, ...this.memory.filter((m) => m.id !== rule.id)];
        break;
      }
      case "memory.removed":
        this.memory = this.memory.filter((m) => m.id !== (data as { id: string }).id);
        break;
      case "team":
        this.teamVersion++;
        void this.refresh();
        break;
      case "limit":
        this.notify("An editor is waiting for the usage limit to reset.");
        break;
    }
    this.emit();
  }

  notify(text: string) {
    this.toast = { text, id: uid() };
    this.emit();
  }

  /** Runs an engine call and turns any failure into a plain toast. */
  async attempt<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (e) {
      this.notify((e as Error).message);
      return null;
    }
  }

  private dismiss(e: Editor) {
    if (this.selectedId === e.id) this.selectedId = null;
    e.mission = null;
    e.questions = [];
    e.status = "idle";
    this.walkTo(e, "dock", "leave");
    e.detail = "Heading home";
  }

  /** Sample crew for demos and tests. A normal studio starts empty. */
  private seedDemo() {
    this.queue = [...QUEUED_MISSIONS];
    this.names = this.names.filter((n) => !CREW_SEED.some((c) => c.name === n.name) && n.name !== "Dewi");
    CREW_SEED.forEach((seed, i) => {
      const station = STAGES[seed.stage].station;
      const spots = STATIONS[station].spots;
      const spot = spots[i % spots.length];
      const e = this.makeEditor(seed.name, seed.role, seed.look, seed.mission, spot.x, spot.y);
      e.stage = seed.stage;
      e.stageProgress = seed.progress;
      e.station = station;
      e.spot = spot;
      e.face = spot.face;
      e.activity = "working";
      e.detail = STAGES[seed.stage].detail[0];
      e.overall = (seed.stage + seed.progress) / STAGES.length;
      this.seedChat(e);
      this.editors.push(e);
    });

    // A believable opening moment: one editor needs you, one is on a break.
    const noor = this.editors[1];
    this.raiseDecision(noor);
    const leo = this.editors[4];
    leo.spot = STATIONS.render.spots[0];
    leo.x = leo.spot.x;
    leo.y = leo.spot.y;
    leo.station = "render";
    const mei = this.editors[5];
    mei.activity = "stuck";
    mei.timer = 12;
    mei.detail = "Caption font missing, retrying";
    const lazy = this.makeEditor("Dewi", "All-round editor", 7, null, 122, 318);
    lazy.activity = "resting";
    lazy.station = "hammock";
    lazy.detail = "Off duty, in the hammock";
    lazy.timer = 45;
    lazy.messages.push({ id: uid(), from: "editor", text: "I'm free right now. Give me a video and I'll take it from there." });
    this.editors.push(lazy);
  }

  private makeEditor(name: string, role: string, look: number, mission: Mission | null, x: number, y: number): Editor {
    return {
      id: `editor-${name.toLowerCase()}`,
      name,
      role,
      look,
      mission,
      stage: 0,
      stageProgress: 0,
      overall: 0,
      activity: "working",
      detail: "",
      x,
      y,
      face: "down",
      pose: "stand",
      anim: Math.random() * 10,
      path: [],
      spot: null,
      station: "living",
      timer: 0,
      after: "resume",
      decided: 0,
      decisionOpen: null,
      messages: [],
      hue: look,
      version: 1,
      thought: 6 + Math.random() * 12,
      model: "sonnet",
      effort: "medium",
      accountId: "default",
      draft: "",
      status: "idle",
      loaded: false,
      questions: [],
      started: false,
    };
  }

  private seedChat(e: Editor) {
    if (!e.mission) return;
    e.messages.push({ id: uid(), from: "system", text: `${e.mission.title} · ${e.mission.style}` });
    e.messages.push({ id: uid(), from: "user", text: `Use my ${e.mission.style} style. Keep it honest and let the pauses breathe.` });
    e.messages.push({
      id: uid(),
      from: "editor",
      text: "Got it. I'll run on Autopilot and only stop you for anything hard to undo. Everything else lands in your Review list.",
    });
    for (let i = 0; i < e.stage; i++) {
      e.messages.push({ id: uid(), from: "editor", text: `${STAGES[i].label} done.`, tool: STAGES[i].label });
    }
    e.messages.push({ id: uid(), from: "editor", text: `${STAGES[e.stage].verb}…`, tool: STAGES[e.stage].label });
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    localStorage.setItem("dojo.theme", theme);
    applyTheme(theme);
    this.emit();
  }

  /** A new chat is a new editor: they step off the dock and walk up to the villa. */
  newChat() {
    if (this.live) {
      void this.createChat();
      return null;
    }
    if (this.editors.filter((x) => !x.parentId).length >= MAX_EDITORS) {
      this.toast = { text: `Your studio is full. End a chat to make room for another editor.`, id: uid() };
      this.emit();
      return null;
    }
    const pick = this.names.shift()!;
    const e = this.makeEditor(pick.name, "All-round editor", pick.look, null, 392, 428);
    e.model = this.lastModel.model;
    e.effort = this.lastModel.effort;
    this.editors.push(e);
    this.walkTo(e, "living", "waiting", 12 + Math.random() * 10);
    this.selectedId = e.id;
    this.emit();
    return e;
  }

  async createChat(options: { accountId?: string; model?: string; effort?: string; brief?: Brief; clientId?: string | null } = {}) {
    const view = await this.attempt(() => api<ChatView>("POST", "/api/chats", { model: this.lastModel.model, effort: this.lastModel.effort, ...options }));
    if (!view) return null;
    this.syncChat(view);
    this.select(view.id);
    return view;
  }

  /** The editor walks back to the dock and leaves. Their name returns to the pool. */
  endChat(id: string) {
    if (this.live) {
      void this.attempt(() => api("DELETE", `/api/chats/${id}`));
      return;
    }
    const e = this.editors.find((v) => v.id === id);
    if (!e) return;
    e.mission = null;
    e.decisionOpen = null;
    if (this.selectedId === id) this.selectedId = null;
    this.walkTo(e, "dock", "leave");
    e.detail = "Heading home";
    this.emit();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  emit() {
    this.listeners.forEach((fn) => fn());
  }

  selected() {
    return this.editors.find((e) => e.id === this.selectedId) ?? null;
  }

  select(id: string | null) {
    this.selectedId = id;
    if (this.live) {
      this.syncUsage();
      if (id) void this.attempt(() => this.loadMessages(id));
    }
    this.emit();
  }

  /** The account the next chat starts on. A running chat keeps its own. */
  useAccount(id: string) {
    this.settings = { ...this.settings, account: id };
    void this.attempt(() => api("POST", "/api/settings", { account: id }));
    this.syncUsage();
    this.emit();
  }

  answer(decisionId: string, answer: unknown) {
    void this.attempt(() => api("POST", `/api/decisions/${decisionId}`, { answer }));
  }

  stop(id: string) {
    void this.attempt(() => api("POST", `/api/chats/${id}/interrupt`));
  }

  needsYou() {
    return this.editors.filter((e) => e.activity === "needs" || e.questions.length > 0 || (e.mission && STAGES[e.stage].id === "review"));
  }

  private freeSpot(station: StationId, e: Editor): Spot {
    const spots = STATIONS[station].spots;
    const taken = (s: Spot) => this.editors.some((o) => o !== e && o.spot === s);
    return spots.find((s) => !taken(s)) ?? spots[Math.floor(Math.random() * spots.length)];
  }

  private walkTo(e: Editor, station: StationId, after: Editor["after"], timer = 0) {
    const spot = this.freeSpot(station, e);
    e.spot = spot;
    e.station = station;
    e.path = findPath(e.x, e.y, spot.x, spot.y);
    e.activity = "walking";
    e.after = after;
    e.timer = timer;
    e.detail = `Heading to ${STATIONS[station].label}`;
  }

  private beginStage(e: Editor) {
    const stage = STAGES[e.stage];
    e.stageProgress = 0;
    e.messages.push({ id: uid(), from: "editor", text: `${stage.verb}…`, tool: stage.label });
    this.walkTo(e, stage.station, "working");
  }

  private raiseDecision(e: Editor) {
    const pick = BROLL_PROMPTS[e.decided % BROLL_PROMPTS.length];
    const decision: Decision = { id: `d${uid()}`, prompt: pick.line, at: pick.at, options: pick.options };
    e.decided++;
    e.decisionOpen = decision;
    e.activity = "needs";
    e.detail = "Needs your pick";
    e.messages.push({ id: uid(), from: "editor", text: "I'm not fully sure on this one. Which B-roll feels right?", decision });
  }

  choose(editorId: string, decisionId: string, optionId: string) {
    const e = this.editors.find((v) => v.id === editorId);
    if (!e || e.decisionOpen?.id !== decisionId) return;
    const option = e.decisionOpen.options.find((o) => o.id === optionId);
    e.decisionOpen.chosen = optionId;
    e.decisionOpen = null;
    e.activity = "working";
    e.detail = STAGES[e.stage].detail[0];
    e.messages.push({ id: uid(), from: "user", text: option ? `Use “${option.label}”.` : "None of these." });
    e.messages.push({ id: uid(), from: "editor", text: option ? "Locked in. I've saved that to your taste memory." : "No problem. I'll search again and flag it in Review." });
    this.emit();
  }

  setModel(editorId: string, model: string, effort: string) {
    const e = this.editors.find((v) => v.id === editorId);
    if (!e) return;
    e.model = model;
    e.effort = effort;
    this.lastModel = { model, effort };
    if (this.live) void this.attempt(() => api("PATCH", `/api/chats/${editorId}`, { model, effort: effort || null }));
    this.emit();
  }

  setAccount(editorId: string, accountId: string) {
    void this.attempt(() => api("PATCH", `/api/chats/${editorId}`, { accountId }));
  }

  send(editorId: string, text: string, attachments: Attachment[] = [], options: { compactFirst?: boolean } = {}) {
    const e = this.editors.find((v) => v.id === editorId);
    if (!e || (!text.trim() && !attachments.length)) return;
    if (this.live) {
      void this.attempt(() => api("POST", `/api/chats/${editorId}/messages`, { text, attachments: attachments.map((a) => ({ hash: a.hash, role: a.role, tags: a.tags })), compactFirst: options.compactFirst === true }));
      return;
    }
    e.messages.push({ id: uid(), from: "user", text, attachments });
    const footage = attachments.find((a) => a.role === "footage");
    const reference = attachments.some((a) => a.role === "reference");
    if (!e.mission && (footage || (text.trim() && !reference))) {
      const title = text.trim() ? text.trim().slice(0, 44) : footage!.name.replace(/\.[^.]+$/, "");
      e.mission = { title, style: "Default", length: "--:--" };
      e.stage = 0;
      e.overall = 0;
      e.messages.push({ id: uid(), from: "editor", text: "On it. Autopilot is on, so I'll only stop you if something can't be undone." });
      this.beginStage(e);
      this.emit();
      return;
    }
    const previous = e.activity;
    if (previous === "working" || previous === "resting") {
      e.activity = "thinking";
      e.timer = 2.4;
      e.after = previous === "resting" ? "resting" : "working";
      e.detail = "Reading your note";
    }
    window.setTimeout(() => {
      e.messages.push({
        id: uid(),
        from: "editor",
        text: attachments.some((a) => a.role === "reference")
          ? "Got the reference. Claude will study its cuts, pacing and captions, then show you a Style Card to approve."
          : e.mission
          ? "On it. I'll apply that now and save it as a preference if it comes up again."
          : "Happy to help. Start a new video from the mission board and pick me.",
      });
      this.emit();
    }, 1500);
    this.emit();
  }

  /** Creates the chat with its brief, so the editor never needs to ask about mode or style. */
  async startVideo(brief: Brief, text: string, files: Attachment[], options: { accountId?: string; model: string; effort: string; clientId?: string | null }) {
    const view = await this.createChat({ ...options, brief });
    if (view) this.send(view.id, text, files);
  }

  startMission(mission: Mission, why: string, reference?: Attachment, model = this.lastModel) {
    const open = this.selected();
    const e = open && !open.mission ? open : this.newChat();
    if (!e) return;
    e.model = model.model;
    e.effort = model.effort;
    this.assign(e, mission, why, reference);
    this.selectedId = e.id;
    this.emit();
  }

  private assign(e: Editor, mission: Mission, why: string, reference?: Attachment) {
    e.mission = mission;
    e.stage = 0;
    e.stageProgress = 0;
    e.overall = 0;
    e.version = 1;
    e.messages.push({ id: uid(), from: "system", text: `${mission.title} · ${mission.style}` });
    if (why || reference) e.messages.push({ id: uid(), from: "user", text: why, attachments: reference ? [reference] : [] });
    e.messages.push({ id: uid(), from: "editor", text: "On it. Autopilot is on, so I'll only stop you if something can't be undone." });
    this.beginStage(e);
  }

  approve(editorId: string) {
    const e = this.editors.find((v) => v.id === editorId);
    if (!e) return;
    this.shipped++;
    this.minutesSaved += 96;
    e.messages.push({ id: uid(), from: "system", text: `${e.mission?.title} approved and exported.` });
    e.mission = null;
    e.stage = 0;
    e.activity = "celebrating";
    e.timer = 3.5;
    e.after = "waiting";
    e.detail = "Shipped!";
    this.reviewId = null;
    this.toast = { text: `${e.name} shipped the video.`, id: uid() };
    this.emit();
  }

  revise(editorId: string, note: string) {
    const e = this.editors.find((v) => v.id === editorId);
    if (!e) return;
    e.version++;
    e.messages.push({ id: uid(), from: "user", text: note });
    e.messages.push({ id: uid(), from: "editor", text: `Making V${e.version} now. V${e.version - 1} stays saved.` });
    e.stage = 5;
    this.reviewId = null;
    this.beginStage(e);
    this.emit();
  }

  private finishStage(e: Editor) {
    const stage = STAGES[e.stage];
    e.messages.push({ id: uid(), from: "editor", text: `${stage.label} done.`, tool: stage.label });
    if (stage.id === ("render" satisfies StageId)) {
      e.stage++;
      this.walkTo(e, "review", "celebrating", 2.5);
      return;
    }
    e.stage++;
    const roll = Math.random();
    if (roll < 0.34) {
      this.walkTo(e, "living", "coffee", 6 + Math.random() * 5);
    } else {
      this.beginStage(e);
    }
  }

  private arrive(e: Editor) {
    if (e.spot) {
      e.x = e.spot.x;
      e.y = e.spot.y;
      e.face = e.spot.face;
    }
    const next = e.after;
    if (next === "leave") {
      this.editors = this.editors.filter((v) => v !== e);
      this.names.push({ name: e.name, look: e.look });
      this.emit();
      return;
    }
    if (this.live && e.status !== "idle") {
      e.activity = ACTIVITY[e.status];
      return;
    }
    if (next === "working") {
      e.activity = "working";
      e.detail = STAGES[e.stage].detail[0];
      return;
    }
    if (next === "resume") {
      this.beginStage(e);
      return;
    }
    e.activity = next;
    if (next === "coffee") e.detail = "Grabbing a coffee";
    if (next === "chatting") e.detail = "Trading ideas";
    if (next === "celebrating") e.detail = "Ready for review";
    if (next === "resting") {
      e.detail = "Off duty, in the hammock";
      e.timer = 30 + Math.random() * 40;
    }
    if (next === "waiting") e.detail = "Wandering the villa";
  }

  private wander(e: Editor) {
    const options: StationId[] = ["dock", "living", "hammock", "review"];
    const station = options[Math.floor(Math.random() * options.length)];
    if (station === "hammock") {
      const busy = this.editors.some((o) => o !== e && o.station === "hammock");
      if (busy) return this.walkTo(e, "dock", "waiting", 12);
      return this.walkTo(e, "hammock", "resting");
    }
    this.walkTo(e, station, "waiting", 10 + Math.random() * 10);
  }

  update(dt: number) {
    this.clock += (THEME_HOURS[this.theme] - this.clock) * Math.min(1, dt * 1.5);
    if (!this.live) {
      const working = this.editors.filter((e) => e.activity === "working").length;
      this.usage.session = Math.max(0.09, this.usage.session - dt * 0.00003 * working);
      this.usage.weekly = Math.max(0.09, this.usage.weekly - dt * 0.00001 * working);
      this.usage.fable = Math.max(0.09, this.usage.fable - dt * 0.000006 * working);
      this.usage.sessionResetMin = Math.max(1, this.usage.sessionResetMin - dt / 60);
    }

    this.updateBoat(dt);
    for (const e of this.editors) this.updateEditor(e, dt);

    const now = performance.now();
    if (now - this.lastNotify > 280) {
      this.lastNotify = now;
      this.emit();
    }
  }

  private updateBoat(dt: number) {
    const b = this.boat;
    const dockX = DOCK.x + 62;
    if (b.state === "away") {
      b.timer -= dt;
      if (b.timer <= 0) {
        b.state = "arriving";
        b.x = 830;
      }
    } else if (b.state === "arriving") {
      b.x -= dt * 44;
      if (b.x <= dockX) {
        b.x = dockX;
        b.state = "docked";
        b.timer = 7;
        const p = b.passenger;
        if (p) {
          b.passenger = null;
          p.messages.push({ id: uid(), from: "editor", text: "Footage received. Walking it up to the villa." });
          this.beginStage(p);
        }
      }
    } else if (b.state === "docked") {
      b.timer -= dt;
      if (b.timer <= 0) b.state = "leaving";
    } else {
      b.x += dt * 44;
      if (b.x > 830) {
        b.state = "away";
        b.timer = 46;
      }
    }
  }

  private updateEditor(e: Editor, dt: number) {
    e.anim += dt;
    if (this.boat.passenger === e) {
      e.x = this.boat.x - 20;
      e.y = 442;
      e.pose = "stand";
      e.face = "left";
      e.detail = "Arriving by boat";
      e.activity = "walking";
      return;
    }

    if (e.path.length) {
      const [tx, ty] = e.path[0];
      const dx = tx - e.x;
      const dy = ty - e.y;
      const dist = Math.hypot(dx, dy);
      const move = 31 * dt;
      if (dist <= move) {
        e.x = tx;
        e.y = ty;
        e.path.shift();
        if (!e.path.length) this.arrive(e);
      } else {
        e.x += (dx / dist) * move;
        e.y += (dy / dist) * move;
        e.face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
      }
      e.pose = "walk";
      return;
    }

    const stage = STAGES[e.stage];
    if (this.live && e.status !== "idle") {
      e.pose = { working: POSE[e.station] ?? "type", thinking: "think", needs: "hand", stuck: "slump", resting: "sleep" }[e.status] as Pose;
      if (e.status === "needs") e.face = "down";
      return;
    }
    switch (e.activity) {
      case "working": {
        if (stage.id === "review") {
          e.activity = "celebrating";
          e.timer = 2;
          break;
        }
        e.pose = stage.id === "broll" ? "read" : stage.id === "render" ? "watch" : "type";
        e.stageProgress += dt / (stage.id === "render" ? 46 : 34);
        e.overall = (e.stage + Math.min(1, e.stageProgress)) / STAGES.length;
        const details = stage.detail;
        e.detail = details[Math.floor(e.stageProgress * details.length) % details.length];
        e.thought -= dt;
        if (e.thought <= 0) {
          e.thought = 14 + Math.random() * 16;
          const r = Math.random();
          if (r > 0.9) {
            e.activity = "stuck";
            e.timer = 7;
            e.detail = "Hit a snag, retrying";
          } else if (stage.id === "broll" && !this.needsYou().some((o) => o.activity === "needs") && r < 0.55) {
            this.raiseDecision(e);
          } else {
            e.activity = "thinking";
            e.timer = 2.6;
            e.after = "working";
            e.detail = "Thinking it through";
          }
        }
        if (e.stageProgress >= 1) this.finishStage(e);
        break;
      }
      case "thinking":
        e.pose = "think";
        e.timer -= dt;
        if (e.timer <= 0) {
          e.activity = e.after === "resting" ? "resting" : "working";
          e.detail = e.activity === "resting" ? "Off duty, in the hammock" : stage.detail[0];
        }
        break;
      case "stuck":
        e.pose = "slump";
        e.timer -= dt;
        if (e.timer <= 0) {
          e.activity = "working";
          e.detail = stage.detail[0];
          e.messages.push({ id: uid(), from: "editor", text: "Sorted that snag myself. Carrying on." });
        }
        break;
      case "needs":
        e.pose = "hand";
        e.face = "down";
        break;
      case "coffee":
        e.pose = "coffee";
        e.face = "down";
        e.timer -= dt;
        if (e.timer <= 0) {
          const partner = this.editors.find((o) => o !== e && o.activity === "coffee");
          if (partner && Math.random() < 0.7) {
            e.activity = "chatting";
            e.timer = 7;
            e.detail = `Chatting with ${partner.name}`;
          } else this.beginStage(e);
        }
        break;
      case "chatting":
        e.pose = "chat";
        e.timer -= dt;
        if (e.timer <= 0) this.beginStage(e);
        break;
      case "celebrating":
        e.pose = "cheer";
        e.face = "down";
        e.timer -= dt;
        if (e.timer <= 0) {
          if (e.mission) {
            e.pose = "stand";
            e.activity = "waiting";
            e.detail = "Ready for review";
            e.timer = 9999;
            if (!this.live) e.messages.push({ id: uid(), from: "editor", text: "First cut is ready. I made 4 small calls, and they're all in your Review list." });
          } else {
            e.activity = "waiting";
            e.timer = 0;
          }
        }
        break;
      case "waiting":
        e.pose = "stand";
        e.timer -= dt;
        if (e.mission && stage.id === "review") {
          e.timer = 9999;
          break;
        }
        if (e.timer <= 0) {
          if (!e.mission && this.queue.length && Math.random() < 0.5) {
            const next = this.queue.shift()!;
            this.assign(e, next, "");
            this.queue.push(next);
          } else this.wander(e);
        }
        break;
      case "resting":
        e.pose = "sleep";
        e.timer -= dt;
        if (e.timer <= 0) this.wander(e);
        break;
      default:
        e.pose = "stand";
    }
  }
}

export const store = new Store();

export function useStore() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => store.subscribe(force), []);
  return store;
}

export function bubbleFor(e: Editor) {
  if (e.activity === "needs") return "alert";
  if (e.activity === "thinking") return "think";
  if (e.activity === "coffee") return "coffee";
  if (e.activity === "chatting") return "chat";
  if (e.activity === "celebrating") return "star";
  if (e.activity === "resting") return "zzz";
  if (e.activity === "stuck") return "warn";
  if (e.mission && STAGES[e.stage].id === "review") return "check";
  if (e.activity === "working") return STAGES[e.stage].icon;
  return null;
}

export const stateLabel: Record<Activity, string> = {
  working: "Working",
  walking: "Walking",
  thinking: "Thinking",
  needs: "Needs you",
  coffee: "On a break",
  chatting: "Chatting",
  celebrating: "Celebrating",
  resting: "Resting",
  stuck: "Stuck",
  waiting: "Idle",
};
