import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Brief, ChatRow, Chats, Station } from "./claude/chat.ts";
import { inside } from "./claude/policy.ts";
import { DIRS, PLUGIN_DIR, earshotPython } from "./config.ts";
import { json } from "./db.ts";
import type { Database } from "./db.ts";
import type { Docs } from "./docs.ts";
import type { Op } from "./editdoc.ts";
import type { Files } from "./files.ts";
import type { Library } from "./library.ts";
import { frameAt } from "./lib/media.ts";
import { secrets } from "./lib/secrets.ts";
import { paceOf, writeBrief } from "./motion.ts";
import { run } from "./lib/proc.ts";
import { nativeBin } from "./config.ts";
import type { Styles } from "./styles.ts";
import type { Tools } from "./tools.ts";

export const EPIDEMIC_URL = "https://www.epidemicsound.com/a/mcp-service/mcp";

type Deps = { db: Database; chats: () => Chats; docs: Docs; files: Files; library: Library; styles: Styles; tools: Tools };
type Result = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

const STAGES: Record<string, { station: Station; detail: string }> = {
  cutting: { station: "cutting", detail: "Cutting A-roll" },
  broll: { station: "library", detail: "Choosing B-roll" },
  captions: { station: "captions", detail: "Timing captions" },
  graphics: { station: "animation", detail: "Building motion graphics" },
  sound: { station: "sound", detail: "Designing sound" },
  review: { station: "review", detail: "Ready for review" },
};

const entrance = z.strictObject({ kind: z.enum(["none", "fade", "slide_up", "slide_down", "slide_left", "slide_right", "pop"]), seconds: z.number().min(0.02).max(3) });
const box = z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).describe("Place in the frame as fractions from the top left.");
const cameraKind = z.enum(["push_in", "pull_out", "punch_in", "pan_left", "pan_right", "pan_up", "pan_down", "shake"]);

const text = (v: unknown): Result => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });

/** A failed tool should tell Claude what went wrong, not end the turn. */
const safe = <A>(fn: (args: A, extra: { signal?: AbortSignal }) => Promise<Result>) => async (args: A, extra: unknown): Promise<Result> => {
  try {
    return await fn(args, extra as { signal?: AbortSignal });
  } catch (e) {
    return { content: [{ type: "text", text: (e as Error).message }], isError: true };
  }
};

/** A tool can only reach this mission, the file store and the library. */
function allowedPath(chat: ChatRow, path: string) {
  const full = resolve(chat.cwd, path);
  if (![chat.cwd, DIRS.files, DIRS.library, PLUGIN_DIR].some((root) => inside(full, root))) throw new Error(`That path is outside this mission: ${path}`);
  if (!existsSync(full)) throw new Error(`There is no file at ${path}.`);
  return full;
}

/** One strict shape per edit, so a guessed field fails here instead of vanishing and breaking the render later. */
const opSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("remove_words"), from: z.number().int(), to: z.number().int(), reason: z.string().optional() }),
  z.strictObject({ op: z.literal("restore_words"), from: z.number().int(), to: z.number().int() }),
  z.strictObject({ op: z.literal("set_max_pause"), seconds: z.number().nullable() }),
  z.strictObject({ op: z.literal("keep_pause"), word: z.number().int() }),
  z.strictObject({ op: z.literal("add_broll"), from: z.number().int(), to: z.number().int(), shotId: z.string().optional(), path: z.string().optional(), in: z.number().optional(), label: z.string().optional(), enter: entrance.optional(), exit: entrance.optional(), box: box.optional(), speed: z.number().optional(), move: z.strictObject({ kind: cameraKind, amount: z.number() }).optional() }),
  z.strictObject({ op: z.literal("add_graphic"), from: z.number().int(), to: z.number().int(), path: z.string(), label: z.string().optional(), enter: entrance.optional(), exit: entrance.optional(), box: box.optional(), reservation: z.string().optional().describe("The Motion agent brief id this clip fulfils."), hideCaptions: z.boolean().optional().describe("Turn captions off across this clip, because it shows the words itself.") }),
  z.strictObject({ op: z.literal("add_move"), from: z.number().int(), to: z.number().int(), kind: cameraKind, amount: z.number().optional().describe("0.08 means 8%."), ease: z.enum(["smooth", "snap", "linear"]).optional(), x: z.number().optional(), y: z.number().optional() }),
  z.strictObject({ op: z.literal("add_transition"), word: z.number().int().describe("The first word after a cut. See cutsBeforeWords in get_edit_doc."), kind: z.enum(["fade", "dissolve", "dip_black", "dip_white", "slide_left", "slide_right", "slide_up", "slide_down", "smooth_left", "smooth_right", "zoom_in", "blur", "circle", "whip_left", "whip_right"]), seconds: z.number().optional() }),
  z.strictObject({ op: z.literal("add_card"), from: z.number().int(), to: z.number().int(), color: z.string(), label: z.string().optional() }),
  z.strictObject({ op: z.literal("add_effect"), from: z.number().int(), to: z.number().int(), kind: z.enum(["flash", "blur", "rgb_split", "grain"]), amount: z.number().optional() }),
  z.strictObject({ op: z.literal("style_words"), from: z.number().int(), to: z.number().int(), scale: z.number().optional(), font: z.string().optional(), color: z.string().optional(), breakBefore: z.boolean().optional(), x: z.number().optional(), y: z.number().optional() }),
  z.strictObject({ op: z.literal("clear_word_styles"), from: z.number().int(), to: z.number().int() }),
  z.strictObject({ op: z.literal("add_sfx"), word: z.number().int(), path: z.string(), offset: z.number().optional(), gainDb: z.number().optional(), label: z.string().optional() }),
  z.strictObject({ op: z.literal("add_music"), path: z.string(), gainDb: z.number().optional(), duck: z.boolean().optional(), label: z.string().optional() }),
  z.strictObject({ op: z.literal("remove_item"), id: z.string() }),
  z.strictObject({ op: z.literal("set_captions"), enabled: z.boolean().optional(), maxWords: z.number().int().optional(), uppercase: z.boolean().optional(), font: z.string().optional(), size: z.number().optional(), color: z.string().optional(), highlight: z.string().optional(), position: z.number().optional(), x: z.number().optional(), strokeColor: z.string().optional(), strokeWidth: z.number().optional(), glowColor: z.string().optional(), glowRadius: z.number().optional(), boxColor: z.string().optional(), boxOpacity: z.number().optional(), animation: z.enum(["none", "fade", "pop", "rise", "drop", "stretch"]).optional(), animationSeconds: z.number().optional(), reveal: z.enum(["chunk", "word"]).optional(), lineHeight: z.number().optional(), maxWidth: z.number().optional() }),
  z.strictObject({ op: z.literal("set_output"), width: z.number().int(), height: z.number().int() }),
]);

/** What the reference's pace was, so a render can be compared with it. */
function referencePace(chat: ChatRow, d: Deps) {
  const styleId = json<Brief>(chat.mission, {}).styleId;
  const style = styleId ? d.styles.list().find((s) => s.id === styleId) : null;
  const measured = (style?.card as { measurements?: { pace?: unknown } } | undefined)?.measurements?.pace;
  if (measured) return measured;
  const root = join(chat.cwd, "work/reference");
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root)) {
    const facts = join(root, name, "facts.json");
    if (existsSync(facts)) return (JSON.parse(readFileSync(facts, "utf8")) as { pace?: unknown }).pace ?? null;
  }
  return null;
}

export function dojoServer(chat: ChatRow, d: Deps) {
  const id = chat.id;
  const chats = d.chats;
  const stored = async (path: string) => d.files.adopt(allowedPath(chat, path));
  const review = (body: string, at: number | null, kind: string, data?: unknown) => {
    d.db.run("INSERT INTO review_items (chat_id, at_seconds, text, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, at, body, kind, data === undefined ? null : JSON.stringify(data), Date.now());
  };
  const sendVideo = (path: string, name: string, label: string, data: unknown = {}) => chats().note(id, "editor", "video", label, { name, path, ...(data as object) });

  return createSdkMcpServer({
    name: "dojo",
    version: "1.0.0",
    tools: [
      tool("set_stage", "Mark which stage of the edit you are on. Call it before each stage.", { stage: z.enum(["cutting", "broll", "captions", "graphics", "sound", "review"]) }, safe(async ({ stage }) => {
        // Only the end of a turn makes an editor idle. They may still be working after reaching a stage.
        chats().status(id, { stage, status: "working", ...STAGES[stage] });
        return text("ok");
      })),
      tool("log_call", "Record a decision you made without asking, so it appears in the user's Review list. Say what you chose and why in one short line.", { text: z.string(), atSeconds: z.number().optional() }, safe(async (a) => {
        review(a.text, a.atSeconds ?? null, "call");
        return text("Logged.");
      })),
      tool("ask_choice", "Pause and ask the user to pick. For B-roll, pass shotIds from search results so they see real filmstrips. Returns their pick.", {
        question: z.string(), line: z.string().optional(),
        options: z.array(z.object({ label: z.string(), detail: z.string().optional(), shotId: z.string().optional() })).min(2).max(6),
      }, safe(async (a, extra) => {
        const options = a.options.map((o) => {
          if (!o.shotId) return o;
          const s = d.library.shot(o.shotId);
          return { ...o, seconds: s.t1 - s.t0, summary: s.card?.summary ?? "" };
        });
        const answer = (await chats().ask(id, a.options.some((o) => o.shotId) ? "broll" : "choice", { question: a.question, line: a.line, options }, extra.signal)) as { label?: string; shotId?: string; note?: string } | null;
        if (!answer) return text("The user didn't answer. Make the call yourself and log it.");
        if (a.line) for (const o of a.options) if (o.shotId) d.library.logChoice(a.line, o.shotId, o.shotId === answer.shotId, id);
        return text(answer);
      })),

      tool("open_footage", "Open the main video and transcribe it on this Mac. Saves version 1 of the Edit Document.", { path: z.string(), locale: z.string().optional() }, safe(async (a) => {
        const locale = a.locale ?? json<Brief>(chats().row(id).mission, {}).locale ?? "en-US";
        return text(await d.docs.open(id, allowedPath(chat, a.path), locale));
      })),
      tool("get_edit_doc", "Read the transcript with word numbers, plus what is placed where. ~word~ means removed. Pass a range to save tokens.", { from: z.number().int().optional(), to: z.number().int().optional() }, safe(async (a) => text(d.docs.view(id, a.from, a.to)))),
      tool("analyze_takes", "Find repeated takes, false starts and filler words as word ranges. Judge them yourself before removing anything.", {}, safe(async () => text(d.docs.takes(id)))),
      tool("edit_ops", "Apply changes to the Edit Document. Every call saves a new version. from, to and word are word numbers from get_edit_doc. path is a file path from a tool result. For a library shot, give add_broll its shotId, or use use_clip to also record the pick for taste memory. An item's id comes from get_edit_doc.", { ops: z.array(opSchema), note: z.string() }, safe(async (a) => {
        const ops = a.ops.map((o) => {
          if (o.op === "add_broll" && o.shotId) {
            const shot = d.library.shot(o.shotId);
            return { ...o, path: shot.path, in: o.in ?? shot.t0, label: o.label ?? shot.card?.summary?.slice(0, 60) };
          }
          return "path" in o && o.path ? { ...o, path: allowedPath(chat, o.path) } : o;
        });
        return text(d.docs.apply(id, ops as Op[], a.note));
      })),
      tool("restore_version", "Bring back an earlier version of the edit.", { version: z.number().int() }, safe(async (a) => text(d.docs.restore(id, a.version)))),
      tool("render_preview", "Render a fast low-resolution preview of the current edit and show it to the user.", {}, safe(async () => {
        const r = await d.docs.queueRender(id, true);
        sendVideo(r.path, `V${r.version} preview`, `Preview of version ${r.version}`);
        return text({ ...r, next: "Check it with view_frames before describing how it looks." });
      })),
      tool("render_final", "Render at full quality, run the quality check, and write the MP4, SRT and FCPXML for Resolve.", {}, safe(async () => {
        const r = await d.docs.queueRender(id, false);
        sendVideo(r.path, `V${r.version}`, `Version ${r.version}`, { quality: r.quality, srt: r.srt, fcpxml: r.fcpxml });
        return text({ ...r, pace: await paceOf(r.path).catch(() => null), referencePace: referencePace(chat, d) });
      })),
      tool("check_motion", "Measure how alive a video stays: how often something new happens, the longest stretch where nothing does, and any frozen stretches. Compare it with the reference's pace. There is no fixed target; the reference sets it.", { path: z.string() }, safe(async (a) => text({ pace: await paceOf(allowedPath(chat, a.path)), referencePace: referencePace(chat, d) }))),
      tool("list_fonts", "List font names that captions can use. A name that isn't listed quietly falls back to Helvetica.", { search: z.string().optional() }, safe(async (a) => {
        const bin = nativeBin();
        if (!bin) throw new Error("The native tools are not built.");
        const { stdout } = await run(bin, ["fonts"]);
        const fonts = (JSON.parse(stdout.trim().split("\n").pop()!) as { result: { fonts: string[] } }).result.fonts;
        const needle = a.search?.toLowerCase();
        return text(needle ? fonts.filter((f) => f.toLowerCase().includes(needle)) : fonts);
      })),
      tool("brief_motion_agent", "Cut a section of the video out for the Motion agent. Packages the section, its timed words and the reference, and reserves those words. Make one brief per graphic. Then start the Motion agent once with the Agent tool, giving it every brief, and carry on with the rest of the edit.", {
        from: z.number().int(), to: z.number().int(), job: z.string().describe("What this graphic must explain, in a sentence or two."), kind: z.enum(["full_screen", "overlay"]).describe("full_screen replaces the picture. overlay is transparent and sits over the speaker."), notes: z.string().optional(),
      }, safe(async (a) => {
        const brief = await writeBrief(chats().row(id), d.docs, d.styles, a);
        return text({ ...brief, next: `Give the Motion agent this brief with the Agent tool: subagent_type "motion", prompt "Build ${brief.brief}". When it reports back, place ${brief.output} with add_graphic on words ${a.from}-${a.to}, with reservation "${brief.id}"${a.kind === "full_screen" ? " and hideCaptions true, because the clip shows the words itself" : ""}.` });
      })),

      tool("view_frames", "See frames from any video, such as a render you just made. Use it to check captions, framing and overlays before saying a render looks right. Times are seconds into that video.", { path: z.string(), times: z.array(z.number()).min(1).max(8) }, safe(async (a) => {
        const full = allowedPath(chat, a.path);
        const dir = join(chat.cwd, "work/frames");
        mkdirSync(dir, { recursive: true });
        const images: Result["content"] = [];
        for (const [i, t] of a.times.entries()) {
          const path = join(dir, `${randomUUID()}-${i}.jpg`);
          await frameAt(full, t, path, 960);
          images.push({ type: "image", data: readFileSync(path).toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `Frame at ${t}s` });
          rmSync(path, { force: true });
        }
        return { content: images };
      })),

      tool("search_broll", "Search the B-roll library. Write angles that think like an editor: literal, cause, effect, metaphor and contrast, not just the words in the line.", {
        line: z.string().describe("The spoken line this shot sits under."), angles: z.array(z.string()).min(1).max(6), collection: z.string().optional(),
        orientation: z.enum(["vertical", "horizontal"]).optional(), minSeconds: z.number().optional(), energy: z.enum(["calm", "lively"]).optional(),
        exclude: z.array(z.string()).optional(), limit: z.number().int().max(12).optional(),
      }, safe(async (a) => {
        const results = await d.library.search(a);
        if (!results.length) {
          d.library.recordGap(a.line);
          return text(d.library.stats().shots ? "Nothing matched. This gap was recorded." : "The B-roll library is empty.");
        }
        return text(results);
      })),
      tool("browse_library", "Show the library's category tree. Pass a path to go deeper or list shots.", { path: z.string().optional() }, safe(async (a) => {
        const branches = d.library.tree(a.path ?? "");
        return text({ branches, shots: a.path ? d.library.browse(a.path) : [] });
      })),
      tool("view_filmstrip", "See a shot's real frames. Use it before committing to a shot that matters.", { shotId: z.string() }, safe(async (a) => ({ content: [{ type: "image", data: d.library.filmstripData(a.shotId), mimeType: "image/jpeg" }] }))),
      tool("find_similar", "Find shots that look like this one. Runs on this Mac.", { shotId: z.string(), limit: z.number().int().max(12).optional() }, safe(async (a) => text(d.library.similar(a.shotId, a.limit)))),
      tool("use_clip", "Place a library shot over a word range, and record the pick so the library learns this user's taste.", { shotId: z.string(), from: z.number().int(), to: z.number().int(), line: z.string() }, safe(async (a) => {
        const s = d.library.shot(a.shotId);
        const out = d.docs.apply(id, [{ op: "add_broll", from: a.from, to: a.to, path: s.path, in: s.t0, label: s.card?.summary?.slice(0, 60), shotId: a.shotId }], `B-roll on "${a.line.slice(0, 40)}"`);
        d.library.logChoice(a.line, a.shotId, true, id);
        return text(out);
      })),
      tool("log_choice", "Record that a shot was wrong for a line, so it ranks lower next time.", { shotId: z.string(), line: z.string() }, safe(async (a) => {
        d.library.logChoice(a.line, a.shotId, false, id);
        return text("Recorded.");
      })),

      tool("remove_background", "Cut the subject out of a video using Apple Vision on this Mac. Saved once and reused. Returns a transparent video and a mask.", {
        path: z.string(), subject: z.enum(["person", "foreground"]).optional(), quality: z.enum(["accurate", "balanced", "fast"]).optional(), codec: z.enum(["prores", "hevc"]).optional(),
      }, safe(async (a) => {
        const f = await stored(a.path);
        const r = await d.tools.removeBackground(f.hash, a.subject, a.quality, a.codec);
        return text({ path: r.file.path, mask: r.mask.path, reused: r.cached, seconds: r.seconds, coverage: r.coverage });
      })),
      tool("reframe", "Crop a video to a new shape and follow the speaker's face.", { path: z.string(), width: z.number().int(), height: z.number().int() }, safe(async (a) => {
        const f = await stored(a.path);
        const r = await d.tools.runJob<{ file: { path: string }; detected: number; samples: number }>("tool.reframe", { hash: f.hash, width: a.width, height: a.height });
        return text({ path: r.file.path, facesFound: `${r.detected} of ${r.samples}` });
      })),
      tool("parallax", "Turn a still or a video's first frame into a 3D camera move using on-device depth.", { path: z.string(), move: z.enum(["orbit", "dolly", "rise"]).optional(), duration: z.number().optional(), amount: z.number().optional() }, safe(async (a) => {
        const f = await stored(a.path);
        const r = await d.tools.runJob<{ file: { path: string } }>("tool.parallax", { hash: f.hash, move: a.move ?? "dolly", duration: a.duration ?? 4, amount: a.amount ?? 0.04 });
        return text({ path: r.file.path });
      })),
      tool("track_camera", "Solve the real 3D camera path from a moving shot. Returns a JSON camera path. Won't work on a locked-off shot.", { path: z.string() }, safe(async (a) => {
        const f = await stored(a.path);
        const r = await d.tools.runJob<{ file: { path: string }; solved: number; frames: number; quality: number }>("tool.track", { hash: f.hash });
        return text({ path: r.file.path, solvedFrames: r.solved, totalFrames: r.frames, quality: r.quality });
      })),
      tool("measure_reference", "Measure a reference video: every cut and transition, camera moves, punch-ins, pace, captions, framing, loudness, music and sound effects. Returns facts, still frames, and frame sequences that show how things move.", { path: z.string(), locale: z.string().optional() }, safe(async (a) => {
        const f = await stored(a.path);
        const dir = join(chat.cwd, "work/reference", f.hash.slice(0, 8));
        mkdirSync(dir, { recursive: true });
        const m = await d.styles.measure(f.hash, a.locale ?? "en-US", dir);
        const facts = JSON.parse(d.styles.factsFor(m)) as Record<string, unknown>;
        const sheets = await d.styles.sequences(m.path, m.moments, m, dir, "motion", 6);
        writeFileSync(join(dir, "facts.json"), JSON.stringify(facts));
        writeFileSync(join(dir, "source.json"), JSON.stringify({ source: m.path }));
        writeFileSync(join(dir, "moments.json"), JSON.stringify({ motion: sheets.map((s) => s.rows) }));
        return text({ facts, frames: m.frames.map((path, i) => ({ path, at: Number(m.picks[i].toFixed(1)) })), sequences: sheets.map((s) => ({ path: s.path, rows: s.rows })), howToRead: "Each row of a sequence sheet is one moment shown as six frames, left to right.", transcript: m.transcript });
      })),
      tool("list_free_sfx", "List the bundled CC0 sound effects. Use the path with add_sfx.", { category: z.string().optional() }, safe(async (a) => {
        const dir = join(PLUGIN_DIR, "skills/sound-effects/sfx");
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { default_kit?: unknown; bundled: { file: string; category: string; duration_s: number; license: string }[] };
        const sounds = manifest.bundled.filter((s) => !a.category || s.category === a.category).map((s) => ({ path: join(dir, s.file), category: s.category, seconds: s.duration_s, license: s.license }));
        return text({ defaultKit: manifest.default_kit, sounds });
      })),
    ],
  });
}

/** Builds every tool server a chat can use. Connections are per chat, so one never sees another's work. */
export async function mcpFor(chat: ChatRow, deps: Deps): Promise<Record<string, McpServerConfig>> {
  const servers: Record<string, McpServerConfig> = { dojo: dojoServer(chat, deps) };
  const python = earshotPython();
  if (python) servers.earshot = { type: "stdio", command: python, args: ["-m", "earshot", "mcp"], env: { EARSHOT_THREADS: "3" } };
  // The key reaches Claude Code in its environment, never on a command line. See `epidemicEnv`.
  if (await secrets.has("epidemic")) servers.epidemic = { type: "http", url: EPIDEMIC_URL, headers: { Authorization: "Bearer ${DOJO_EPIDEMIC_KEY}" } };
  return servers;
}

export const epidemicEnv = async (): Promise<Record<string, string>> => {
  const key = await secrets.get("epidemic");
  return key ? { DOJO_EPIDEMIC_KEY: key } : {};
};
