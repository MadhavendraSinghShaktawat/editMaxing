import { Look } from "../world3d/types";
import { StationId } from "../world/layout";

export type StageId = "brief" | "cut" | "broll" | "animate" | "captions" | "sound" | "render" | "review";

export const STAGES: { id: StageId; label: string; station: StationId; icon: string; verb: string; detail: string[] }[] = [
  { id: "brief", label: "Brief", station: "cutting", icon: "think", verb: "Reading the brief", detail: ["Applying your saved style", "Reading the transcript"] },
  { id: "cut", label: "A-cuts", station: "cutting", icon: "scissors", verb: "Cutting A-roll", detail: ["Removing retakes", "Keeping intentional pauses", "Trimming dead air"] },
  { id: "broll", label: "B-roll", station: "library", icon: "book", verb: "Searching B-roll", detail: ["Writing creative angles", "Checking filmstrips", "Matching shots to words"] },
  { id: "captions", label: "Captions", station: "captions", icon: "text", verb: "Timing captions", detail: ["Aligning words", "Styling highlights"] },
  { id: "animate", label: "Motion", station: "animation", icon: "pen", verb: "Animating graphics", detail: ["Building an explainer scene", "Timing shapes to words"] },
  { id: "sound", label: "Sound", station: "sound", icon: "note", verb: "Designing sound", detail: ["Placing effects", "Ducking music", "Balancing loudness"] },
  { id: "render", label: "Render", station: "render", icon: "gear", verb: "Rendering", detail: ["Rendering frames", "Running quality checks"] },
  { id: "review", label: "Review", station: "review", icon: "star", verb: "Ready for review", detail: ["Waiting at the Review Bale"] },
];

const SKIN = {
  a: ["#f8d2ac"],
  b: ["#e6ae80"],
  c: ["#bd7f52"],
  d: ["#8a5433"],
};

export const LOOKS: Look[] = [
  { skin: SKIN.b[0], hair: "#2b1d1a", hairStyle: "short", shirt: "#f28a2e", pants: "#2f5d6e", shoes: "#f6efe0", headphones: "#f6efe0" },
  { skin: SKIN.c[0], hair: "#1e1720", hairStyle: "long", shirt: "#d9403a", pants: "#2c3f5e", shoes: "#2d1b16" },
  { skin: SKIN.d[0], hair: "#17121a", hairStyle: "curly", shirt: "#f2c230", pants: "#4f3a60", shoes: "#f6efe0", glasses: true },
  { skin: SKIN.a[0], hair: "#7d3f22", hairStyle: "bun", shirt: "#17a5a0", pants: "#6d4a33", shoes: "#2d1b16" },
  { skin: SKIN.b[0], hair: "#3a2318", hairStyle: "cap", shirt: "#7f55d4", pants: "#2e2a3d", shoes: "#f6efe0" },
  { skin: SKIN.a[0], hair: "#e0a848", hairStyle: "bob", shirt: "#f07fa8", pants: "#2f6d7a", shoes: "#2d1b16", glasses: true },
  { skin: SKIN.c[0], hair: "#2b1d1a", hairStyle: "udeng", shirt: "#45a85a", pants: "#5d3622", shoes: "#2d1b16" },
  { skin: SKIN.d[0], hair: "#231815", hairStyle: "afro", shirt: "#3d7fd9", pants: "#efe0bd", shoes: "#2d1b16" },
];

export type Mission = { title: string; style: string; length: string };

export const CREW_SEED: { name: string; role: string; look: number; mission: Mission | null; stage: number; progress: number }[] = [
  { name: "Kai", role: "All-round editor", look: 0, mission: { title: "Why we quit our agency", style: "Mode only", length: "8:42" }, stage: 1, progress: 0.42 },
  { name: "Noor", role: "All-round editor", look: 1, mission: { title: "iPhone camera review", style: "Mode only", length: "11:05" }, stage: 2, progress: 0.3 },
  { name: "Wayan", role: "All-round editor", look: 6, mission: { title: "Ubud morning vlog", style: "Mode only", length: "6:18" }, stage: 5, progress: 0.15 },
  { name: "Aigerim", role: "All-round editor", look: 3, mission: { title: "Notion AI in 60 seconds", style: "Mode only", length: "0:58" }, stage: 3, progress: 0.55 },
  { name: "Leo", role: "All-round editor", look: 4, mission: { title: "Build a landing page", style: "Mode only", length: "14:30" }, stage: 6, progress: 0.2 },
  { name: "Mei", role: "All-round editor", look: 5, mission: { title: "Five mistakes founders make", style: "Mode only", length: "1:12" }, stage: 4, progress: 0.7 },
];

export type ModelOption = { id: string; name: string; note: string; group: "Recommended" | "Older versions"; efforts: string[]; defaultEffort: string; usesFable?: boolean };

/** Claude Code's short aliases always point at the newest model, so they list first. */
export function modelOptions(models: { id: string; name: string; description: string; resolved: string | null; efforts: string[]; fable: boolean }[]): ModelOption[] {
  if (!models.length) return MODELS;
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    note: m.description.split(/ · |\. /)[0] || m.resolved || m.id,
    group: m.id.startsWith("claude-") ? "Older versions" : "Recommended",
    efforts: m.efforts,
    defaultEffort: m.efforts.includes("medium") ? "medium" : (m.efforts[0] ?? ""),
    usesFable: m.fable,
  }));
}

const FULL = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH = ["low", "medium", "high", "max"];

/** Mirrors what Claude Code accepts through --model and --effort. */
export const MODELS: ModelOption[] = [
  { id: "fable", name: "Fable 5.1", note: "Hardest, longest jobs", group: "Recommended", efforts: FULL, defaultEffort: "high", usesFable: true },
  { id: "opus", name: "Opus 5.5", note: "Complex reasoning", group: "Recommended", efforts: FULL, defaultEffort: "medium" },
  { id: "sonnet", name: "Sonnet 5.5", note: "Best for daily edits", group: "Recommended", efforts: FULL, defaultEffort: "medium" },
  { id: "haiku", name: "Haiku 5.5", note: "Fast and light", group: "Recommended", efforts: FULL, defaultEffort: "medium" },
  { id: "opusplan", name: "Opus Plan", note: "Opus plans, Sonnet works", group: "Recommended", efforts: FULL, defaultEffort: "medium" },
  { id: "claude-fable-5", name: "Fable 5", note: "claude-fable-5", group: "Older versions", efforts: FULL, defaultEffort: "high", usesFable: true },
  { id: "claude-opus-5", name: "Opus 5", note: "claude-opus-5", group: "Older versions", efforts: FULL, defaultEffort: "high" },
  { id: "claude-opus-4-8", name: "Opus 4.8", note: "claude-opus-4-8", group: "Older versions", efforts: FULL, defaultEffort: "high" },
  { id: "claude-opus-4-7", name: "Opus 4.7", note: "claude-opus-4-7", group: "Older versions", efforts: FULL, defaultEffort: "xhigh" },
  { id: "claude-opus-4-6", name: "Opus 4.6", note: "claude-opus-4-6", group: "Older versions", efforts: NO_XHIGH, defaultEffort: "high" },
  { id: "claude-sonnet-5", name: "Sonnet 5", note: "claude-sonnet-5", group: "Older versions", efforts: FULL, defaultEffort: "high" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", note: "claude-sonnet-4-6", group: "Older versions", efforts: NO_XHIGH, defaultEffort: "high" },
  { id: "claude-sonnet-4-5", name: "Sonnet 4.5", note: "claude-sonnet-4-5", group: "Older versions", efforts: [], defaultEffort: "" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", note: "claude-haiku-4-5", group: "Older versions", efforts: [], defaultEffort: "" },
];

export const QUEUED_MISSIONS: Mission[] = [
  { title: "Bali co-working tour", style: "Mode only", length: "9:12" },
  { title: "Claude for video editors", style: "Mode only", length: "12:44" },
  { title: "How we price our work", style: "Mode only", length: "7:20" },
  { title: "Three hooks that work", style: "Mode only", length: "0:45" },
];

export const CHAT_NAMES = [
  { name: "Kai", look: 0 },
  { name: "Noor", look: 1 },
  { name: "Sora", look: 2 },
  { name: "Aigerim", look: 3 },
  { name: "Leo", look: 4 },
  { name: "Mei", look: 5 },
  { name: "Wayan", look: 6 },
  { name: "Dewi", look: 7 },
];

export type Thumb = "run" | "desk" | "coffee" | "sunrise" | "city" | "type" | "climb" | "notes";

export const BROLL_PROMPTS: { line: string; at: string; options: { id: string; label: string; why: string; scene: Thumb }[] }[] = [
  {
    line: "“Caffeine got me through the hardest year.”",
    at: "0:42",
    options: [
      { id: "a", label: "Late-night desk", why: "Implies the hard work behind the coffee", scene: "desk" },
      { id: "b", label: "Pouring coffee", why: "The literal choice", scene: "coffee" },
      { id: "c", label: "Pre-dawn run", why: "Discipline and early starts", scene: "run" },
    ],
  },
  {
    line: "“Nobody tells you how lonely it gets.”",
    at: "2:17",
    options: [
      { id: "a", label: "Empty city street", why: "Quiet, with a sense of distance", scene: "city" },
      { id: "b", label: "Sunrise alone", why: "Reflective, with a hopeful lift", scene: "sunrise" },
      { id: "c", label: "Laptop glow", why: "Working alone at night", scene: "type" },
    ],
  },
  {
    line: "“Then we finally reached the top.”",
    at: "5:03",
    options: [
      { id: "a", label: "Mountain climb", why: "A strong visual metaphor", scene: "climb" },
      { id: "b", label: "Sunrise reveal", why: "Warm payoff for the line", scene: "sunrise" },
      { id: "c", label: "Whiteboard plan", why: "Shows the work behind it", scene: "notes" },
    ],
  },
];

export const STARTERS = [
  { label: "Edit a video", note: "Drop footage and pick a style", action: "video" },
  { label: "Learn a style", note: "Study a reference video", prompt: "Learn my editing style from a reference video." },
  { label: "Cut a Reel", note: "Find the best 45 seconds", prompt: "Cut a Reel from my long video. Open on the strongest claim." },
];

export const TOOLS = [
  { id: "removeBackground", name: "Remove background", note: "Saves a transparent video", tag: "Local · Free", icon: "sparkles", params: { subject: "person", quality: "accurate", codec: "prores" } },
  { id: "transcribe", name: "Transcribe", note: "Word-timed transcript", tag: "Local · Free", icon: "text", params: { locale: "en-US" } },
  { id: "cutSilences", name: "Cut silences", note: "Keeps a short natural beat", tag: "Local · Free", icon: "scissors", params: { keepPause: 0.3 } },
  { id: "reframe", name: "Reframe to vertical", note: "Tracks the speaker", tag: "Local · Free", icon: "movie", params: { width: 1080, height: 1920 } },
  { id: "parallax", name: "Depth parallax", note: "Turns a frame into a 3D move", tag: "Local · Pack", icon: "bolt", pack: "depth", params: { move: "dolly", duration: 4, amount: 0.04 } },
  { id: "track", name: "3D camera track", note: "Solves a moving camera", tag: "Local · Pack", icon: "gear", pack: "colmap", params: {} },
];
