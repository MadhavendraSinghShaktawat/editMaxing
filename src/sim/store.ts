import { useEffect, useReducer } from "react";
import { DOCK, Facing, STATIONS, Spot, StationId } from "../world/layout";
import { findPath } from "../world/nav";
import { Pose } from "../world3d/types";
import { BROLL_PROMPTS, CHAT_NAMES, CREW_SEED, Mission, QUEUED_MISSIONS, STAGES, StageId, Thumb } from "./data";

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
};

export type Attachment = {
  id: string;
  name: string;
  kind: "video" | "image" | "file";
  role: "reference" | "footage" | "file";
  size: number;
  duration?: number;
  thumb?: string;
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
};

export const MAX_EDITORS = 8;

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
  private names = [...CHAT_NAMES];
  private queue: Mission[] = [];
  private listeners = new Set<() => void>();
  private lastNotify = 0;

  constructor() {
    const session = Number(new URLSearchParams(location.search).get("session"));
    if (session > 0 && session <= 1) this.usage.session = session;
    applyTheme(this.theme);
    if (new URLSearchParams(location.search).has("demo")) this.seedDemo();
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
    };
  }

  private seedChat(e: Editor) {
    if (!e.mission) return;
    e.messages.push({ id: uid(), from: "system", text: `${e.mission.title} · ${e.mission.mode} · ${e.mission.style}` });
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
    if (this.editors.length >= MAX_EDITORS) {
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

  /** The editor walks back to the dock and leaves. Their name returns to the pool. */
  endChat(id: string) {
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
    this.emit();
  }

  needsYou() {
    return this.editors.filter((e) => e.activity === "needs" || (e.mission && STAGES[e.stage].id === "review"));
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
    this.emit();
  }

  send(editorId: string, text: string, attachments: Attachment[] = []) {
    const e = this.editors.find((v) => v.id === editorId);
    if (!e || (!text.trim() && !attachments.length)) return;
    e.messages.push({ id: uid(), from: "user", text, attachments });
    const footage = attachments.find((a) => a.role === "footage");
    const reference = attachments.some((a) => a.role === "reference");
    if (!e.mission && (footage || (text.trim() && !reference))) {
      const title = text.trim() ? text.trim().slice(0, 44) : footage!.name.replace(/\.[^.]+$/, "");
      e.mission = { title, mode: "Custom", style: "Default", length: "--:--" };
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
    e.messages.push({ id: uid(), from: "system", text: `${mission.title} · ${mission.mode} · ${mission.style}` });
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
    const working = this.editors.filter((e) => e.activity === "working").length;
    this.usage.session = Math.max(0.09, this.usage.session - dt * 0.00003 * working);
    this.usage.weekly = Math.max(0.09, this.usage.weekly - dt * 0.00001 * working);
    this.usage.fable = Math.max(0.09, this.usage.fable - dt * 0.000006 * working);
    this.usage.sessionResetMin = Math.max(1, this.usage.sessionResetMin - dt / 60);

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
            e.messages.push({ id: uid(), from: "editor", text: "First cut is ready. I made 4 small calls, and they're all in your Review list." });
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
