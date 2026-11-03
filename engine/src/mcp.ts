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
import { BROLL_LAYOUTS, BROLL_ROLES } from "./library.ts";
import { frameAt } from "./lib/media.ts";
import { secrets } from "./lib/secrets.ts";
import { paceOf, writeBrief } from "./motion.ts";
import { SCRAPE_MCP, scrapeKeyFor } from "./social.ts";
import { assemble, linesFrom } from "./story.ts";
import { probe } from "./lib/media.ts";
import { run } from "./lib/proc.ts";
import { nativeBin } from "./config.ts";
import type { Memory } from "./memory.ts";
import type { MotionLibrary } from "./motionlib.ts";
import { DOMAINS, LAYERS, OPERATIONS } from "./motionlib.ts";
import type { Styles } from "./styles.ts";
import type { Tools } from "./tools.ts";
import { describeReference } from "./references.ts";
import type { References } from "./references.ts";

export const EPIDEMIC_URL = "https://www.epidemicsound.com/a/mcp-service/mcp";
/** Envato's own MCP server for Envato Elements. Search only, with no sign-in: results link to Envato, where the person downloads and licenses. */
export const ENVATO_URL = "https://mcp.envato.com/mcp";

type Deps = { db: Database; chats: () => Chats; docs: Docs; files: Files; library: Library; motion: MotionLibrary; styles: Styles; tools: Tools; memory: Memory; epidemicKey: (chat: ChatRow) => string; envato: (chat: ChatRow) => boolean; scrape: (chat: ChatRow) => boolean; fetchLink?: (chat: ChatRow, url: string) => Promise<{ file: { hash: string } }>; references?: References };
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
  const style = styleId ? (() => { try { return d.styles.get(styleId); } catch { return null; } })() : null;
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
  // Every library call runs as the person who owns this chat, so an editor only finds their footage.
  const owner = chat.owner_id ?? "";
  const shotFor = (shotId: string) => {
    d.library.mustSeeShot(owner, shotId);
    return d.library.shot(shotId);
  };
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
      tool("ask_choice", "Pause and ask the user to pick. For B-roll, pass shotIds from search results so they see real filmstrips. For motion graphics, pass animationIds from suggest_animations so they see the saved loops. Don't mix the two in one question. Returns their pick.", {
        question: z.string(), line: z.string().optional(),
        options: z.array(z.strictObject({ label: z.string(), detail: z.string().optional(), shotId: z.string().optional(), animationId: z.string().optional() })).min(2).max(6),
      }, safe(async (a, extra) => {
        const shots = a.options.some((o) => o.shotId);
        const anims = a.options.some((o) => o.animationId);
        if (shots && anims) throw new Error("Ask about B-roll and animations in separate questions.");
        const options = a.options.map((o) => {
          if (o.animationId) {
            const v = d.motion.view(owner, o.animationId);
            return { ...o, seconds: v.seconds, summary: v.summary, technique: v.technique?.label ?? null };
          }
          if (!o.shotId) return o;
          const s = shotFor(o.shotId);
          return { ...o, seconds: s.t1 - s.t0, summary: s.card?.summary ?? "" };
        });
        const answer = (await chats().ask(id, shots ? "broll" : anims ? "motion" : "choice", { question: a.question, line: a.line, options }, extra.signal)) as { label?: string; shotId?: string; animationId?: string; note?: string } | null;
        if (!answer) return text("The user didn't answer. Make the call yourself and log it.");
        if (a.line) for (const o of a.options) if (o.shotId) d.library.logChoice(owner, a.line, o.shotId, o.shotId === answer.shotId, id);
        for (const o of a.options) if (o.animationId) d.motion.logChoice(owner, a.line ?? a.question, o.animationId, o.animationId === answer.animationId, id);
        // The person's own pick is the strongest taste signal there is. Memory compares it with what they passed over.
        if (owner) {
          const describe = (o: (typeof options)[number]) => ("summary" in o && o.summary ? `"${o.summary}"` : `"${o.label}"`);
          const chosen = options.find((o) => (answer.shotId ? o.shotId === answer.shotId : answer.animationId ? o.animationId === answer.animationId : o.label === answer.label));
          const passed = options.filter((o) => o !== chosen);
          const kind = shots ? "broll_pick" : anims ? "motion_pick" : "message";
          const said = chosen ? `Picked ${describe(chosen)}` : `Answered ${JSON.stringify(answer.note ?? answer.label ?? "")}`;
          d.memory.signal({ memberId: owner, chatId: id, clientId: chat.client_id, kind, text: `${a.line ? `For the line ${JSON.stringify(a.line)}: ` : `${a.question} `}${said}. Passed over: ${passed.map(describe).join("; ") || "nothing"}.${answer.note ? ` Their note: ${JSON.stringify(answer.note)}` : ""}` });
        }
        return text(answer);
      })),

      tool("open_footage", "Open the main video and transcribe it on this Mac. Saves version 1 of the Edit Document.", { path: z.string(), locale: z.string().optional() }, safe(async (a) => {
        const locale = a.locale ?? json<Brief>(chats().row(id).mission, {}).locale ?? "en-US";
        return text(await d.docs.open(id, allowedPath(chat, a.path), locale));
      })),
      tool("read_clips", "Transcribe several raw clips on this Mac and read them as timed lines, to choose the best takes and story. Use it when there is more than one footage clip. Runs once per clip and is cached.", {
        paths: z.array(z.string()).min(1).max(100).describe("Footage clips from inputs/, in the order they were attached."), locale: z.string().optional(),
      }, safe(async (a) => {
        const locale = a.locale ?? json<Brief>(chats().row(id).mission, {}).locale ?? "en-US";
        const out: { clip: number; path: string; seconds: number; lines: ReturnType<typeof linesFrom> }[] = new Array(a.paths.length);
        let next = 0;
        // Two at a time: transcription is local and heavy, and the clips can be long.
        await Promise.all([0, 1].map(async () => {
          while (next < a.paths.length) {
            const i = next++;
            const f = await stored(a.paths[i]);
            const [info, t] = await Promise.all([probe(f.path), d.tools.transcribe(f.hash, locale)]);
            out[i] = { clip: i + 1, path: a.paths[i], seconds: Number(info.duration.toFixed(2)), lines: linesFrom(t.words) };
          }
        }));
        return text({ clips: out, next: "Pick the takes that tell the best story, or follow the user's script line by line. Then join them with assemble_story and open the result with open_footage." });
      })),
      tool("assemble_story", "Join chosen takes from the raw clips, in order, into one video that becomes the main footage. Times are seconds in each clip, from read_clips. Leave a little air: start a take just before its first word and end it just after its last.", {
        takes: z.array(z.strictObject({ path: z.string(), from: z.number(), to: z.number() })).min(1).max(200), note: z.string().describe("One line on the story you built, for the user."),
      }, safe(async (a, extra) => {
        const full = a.takes.map((t) => ({ path: allowedPath(chat, t.path), from: t.from, to: t.to }));
        mkdirSync(join(chat.cwd, "work"), { recursive: true });
        const name = `work/story-${Date.now().toString(36)}.mp4`;
        const r = await assemble(full, join(chat.cwd, name), join(chat.cwd, "work"), extra.signal);
        review(`Story: ${a.note}`, null, "call", { takes: a.takes });
        return text({ path: name, seconds: r.seconds, takes: r.takes.map((t, i) => ({ ...a.takes[i], startsAt: t.start })), next: `Call open_footage with ${name}. It becomes the main video for every stage.` });
      })),
      tool("get_edit_doc", "Read the transcript with word numbers, plus what is placed where. ~word~ means removed. Pass a range to save tokens.", { from: z.number().int().optional(), to: z.number().int().optional() }, safe(async (a) => text(d.docs.view(id, a.from, a.to)))),
      tool("analyze_takes", "Find repeated takes, false starts and filler words as word ranges. Judge them yourself before removing anything.", {}, safe(async () => text(d.docs.takes(id)))),
      tool("edit_ops", "Apply changes to the Edit Document. Every call saves a new version. from, to and word are word numbers from get_edit_doc. path is a file path from a tool result. For a library shot, give add_broll its shotId, or use use_clip to also record the pick for taste memory. An item's id comes from get_edit_doc.", { ops: z.array(opSchema), note: z.string() }, safe(async (a) => {
        const ops = a.ops.map((o) => {
          if (o.op === "add_broll" && o.shotId) {
            const shot = shotFor(o.shotId);
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
        examples: z.array(z.string()).max(3).optional().describe("Animation ids from suggest_animations for the Motion agent to rebuild on this section."),
      }, safe(async (a) => {
        const examples = (a.examples ?? []).map((e) => d.motion.example(owner, e));
        const { examples: _ids, ...job } = a;
        const brief = await writeBrief(chats().row(id), d.docs, d.styles, job, examples);
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

      tool("suggest_animations", "Find 3 to 5 saved animations for one moment, each a different technique. Name the job the moment needs, like 'make the 3x number land' or 'show the two options side by side'. Filters are optional; use them only when you're sure.", {
        job: z.string().describe("What the moment needs to do for the viewer."), line: z.string().optional().describe("The spoken line it sits under."),
        operation: z.enum(OPERATIONS.map((o) => o.id) as [string, ...string[]]).optional(), domain: z.enum(DOMAINS.map((o) => o.id) as [string, ...string[]]).optional(),
        technique: z.string().optional(), layer: z.enum(LAYERS).optional(), count: z.number().int().min(3).max(5).optional(), exclude: z.array(z.string()).optional(),
      }, safe(async (a) => {
        const styleId = json<Brief>(chats().row(id).mission, {}).styleId ?? null;
        // A mixed style's animations live with the styles it was made from.
        const results = await d.motion.suggest(owner, { ...a, styleIds: styleId ? d.styles.family(styleId).ids : [] });
        return text(results.length ? { options: results, next: "Look at the ones you like with view_animation. Ask with ask_choice and animationIds when the pick matters, then pass the chosen ids to brief_motion_agent as examples." } : "No saved animations match. Learn a style from a reference to fill the Motion library, or brief the Motion agent from the style alone.");
      })),
      tool("view_animation", "See a saved animation frame by frame, left to right, with its rebuild spec.", { id: z.string() }, safe(async (a) => {
        const strip = d.motion.file(owner, a.id, "strip");
        const v = d.motion.mustUse(owner, a.id);
        return { content: [{ type: "image", data: readFileSync(strip).toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: JSON.stringify({ name: v.name, summary: v.summary, card: json(v.card, {}) }) }] };
      })),
      tool("browse_motion", "Show the Motion library's taxonomy: operations (the job), domains (the lever) and techniques (the move), with how many saved animations each has.", {}, safe(async () => {
        const t = d.motion.taxonomy(owner);
        return text({ operations: t.operations.map(({ id, label, description, count }) => ({ id, label, description, count })), domains: t.domains.map(({ id, label, count }) => ({ id, label, count })), techniques: t.techniques.filter((x) => x.count > 0).map(({ id, label, domain, count }) => ({ id, label, domain, count })) });
      })),
      tool("get_caption_preset", "The caption preset saved from this video's style, as a ready set_captions op plus the full caption notes. Check the font with list_fonts before applying it.", { id: z.string().optional().describe("A caption preset id, if the user picked a different one.") }, safe(async (a) => {
        const styleId = json<Brief>(chats().row(id).mission, {}).styleId ?? null;
        const family = styleId ? d.styles.family(styleId) : null;
        const preset = d.motion.captionPreset(owner, { id: a.id, styleId }) ?? (family?.captions ? d.motion.captionPreset(owner, { styleId: family.captions }) : null);
        return text(preset ? { id: preset.id, name: preset.name, setCaptions: preset.card.setCaptions, notes: preset.card.captions } : "This video's style has no saved caption preset. Follow the Style Card's captions area.");
      })),

      tool("search_broll", "Search the B-roll library. Write angles that think like an editor: literal, cause, effect, metaphor and contrast, not just the words in the line.", {
        line: z.string().describe("The spoken line this shot sits under."), angles: z.array(z.string()).min(1).max(6), collection: z.string().optional(),
        orientation: z.enum(["vertical", "horizontal"]).optional(), minSeconds: z.number().optional(), energy: z.enum(["calm", "lively"]).optional(),
        role: z.enum(BROLL_ROLES).optional().describe("The job the shot must do: literal, proof, metaphor, contrast, list or texture."),
        layout: z.enum(BROLL_LAYOUTS).optional().describe("Where it will sit, if not full screen."),
        exclude: z.array(z.string()).optional(), limit: z.number().int().max(12).optional(),
      }, safe(async (a) => {
        const results = await d.library.search(owner, a);
        if (!results.length) {
          d.library.recordGap(owner, a.line);
          return text(d.library.stats(owner).shots ? "Nothing matched. This gap was recorded." : "The B-roll library is empty.");
        }
        return text(results);
      })),
      tool("browse_library", "Show the library's category tree. Pass a path to go deeper or list shots.", { path: z.string().optional() }, safe(async (a) => {
        const branches = d.library.tree(owner, a.path ?? "");
        return text({ branches, shots: a.path ? d.library.browse(owner, a.path) : [] });
      })),
      tool("view_filmstrip", "See a shot's real frames. Use it before committing to a shot that matters.", { shotId: z.string() }, safe(async (a) => (d.library.mustSeeShot(owner, a.shotId), { content: [{ type: "image", data: d.library.filmstripData(a.shotId), mimeType: "image/jpeg" }] }))),
      tool("find_similar", "Find shots that look like this one. Runs on this Mac.", { shotId: z.string(), limit: z.number().int().max(12).optional() }, safe(async (a) => text(d.library.similar(owner, a.shotId, a.limit)))),
      tool("use_clip", "Place a library shot over a word range, and record the pick so the library learns this user's taste.", { shotId: z.string(), from: z.number().int(), to: z.number().int(), line: z.string() }, safe(async (a) => {
        const s = shotFor(a.shotId);
        const out = d.docs.apply(id, [{ op: "add_broll", from: a.from, to: a.to, path: s.path, in: s.t0, label: s.card?.summary?.slice(0, 60), shotId: a.shotId }], `B-roll on "${a.line.slice(0, 40)}"`);
        d.library.logChoice(owner, a.line, a.shotId, true, id);
        return text(out);
      })),
      tool("log_choice", "Record that a shot was wrong for a line, so it ranks lower next time.", { shotId: z.string(), line: z.string() }, safe(async (a) => {
        d.library.mustSeeShot(owner, a.shotId);
        d.library.logChoice(owner, a.line, a.shotId, false, id);
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
      tool("measure_reference", "Measure a reference video: every cut and transition, camera moves, punch-ins, pace, captions, framing, loudness, music and sound effects. Returns facts, still frames, and frame sequences that show how things move. Measure every attached reference, and pass what the user marked it for as use. path can also be a Drive or social video link, which is downloaded whole first.", { path: z.string(), locale: z.string().optional(), use: z.array(z.enum(["editing", "motion", "explainer", "captions", "sound"])).optional().describe("What the user marked this reference for. Leave out when it isn't marked.") }, safe(async (a) => {
        const link = /^https?:\/\//i.test(a.path.trim());
        if (link && !d.fetchLink) throw new Error("Links can't be downloaded here. Ask the user to attach the video file.");
        const f = link ? (await d.fetchLink!(chat, a.path.trim())).file : await stored(a.path);
        const dir = join(chat.cwd, "work/reference", f.hash.slice(0, 8));
        mkdirSync(dir, { recursive: true });
        const m = await d.styles.measure(f.hash, a.locale ?? "en-US", dir);
        const facts = JSON.parse(d.styles.factsFor(m)) as Record<string, unknown>;
        const sheets = await d.styles.sequences(m.path, m.moments, m, dir, "motion", 6);
        writeFileSync(join(dir, "facts.json"), JSON.stringify(facts));
        writeFileSync(join(dir, "source.json"), JSON.stringify({ source: m.path, use: a.use ?? [] }));
        writeFileSync(join(dir, "moments.json"), JSON.stringify({ motion: sheets.map((s) => s.rows) }));
        // A reference measured here (often a pasted link) joins the library the same way an attached one does.
        const saved = d.references ? (await d.references.ensure(chats().row(id), [{ hash: f.hash, tags: a.use }]).catch(() => []))[0] : undefined;
        return text({ library: saved ? describeReference(saved) : undefined, facts, frames: m.frames.map((path, i) => ({ path, at: Number(m.picks[i].toFixed(1)) })), sequences: sheets.map((s) => ({ path: s.path, rows: s.rows })), howToRead: "Each row of a sequence sheet is one moment shown as six frames, left to right.", transcript: m.transcript });
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
  // Each person brings their own Epidemic key, because its licence can't be shared.
  if (await secrets.has(deps.epidemicKey(chat))) servers.epidemic = { type: "http", url: EPIDEMIC_URL, headers: { Authorization: "Bearer ${DOJO_EPIDEMIC_KEY}" } };
  // Each person connects Envato themselves, since an Elements licence belongs to whoever downloads.
  if (deps.envato(chat)) servers.envato = { type: "http", url: ENVATO_URL };
  // Scrape Creators spends the person's own credits, so it joins a chat only when they turned it on.
  if (chat.owner_id && deps.scrape(chat) && (await secrets.has(scrapeKeyFor(chat.owner_id)))) servers.scrapecreators = { type: "http", url: SCRAPE_MCP, headers: { "x-api-key": "${DOJO_SCRAPECREATORS_KEY}" } };
  return servers;
}

export const epidemicEnv = async (keyName: string): Promise<Record<string, string>> => {
  const key = await secrets.get(keyName);
  return key ? { DOJO_EPIDEMIC_KEY: key } : {};
};

/** The person's Scrape Creators key, for a chat that has the tools turned on. */
export const scrapeEnv = async (memberId: string | null, on: boolean): Promise<Record<string, string>> => {
  if (!memberId || !on) return {};
  const key = await secrets.get(scrapeKeyFor(memberId));
  return key ? { DOJO_SCRAPECREATORS_KEY: key } : {};
};
