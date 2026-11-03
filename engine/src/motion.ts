import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Brief, ChatRow } from "./claude/chat.ts";
import { findBin } from "./config.ts";
import { json } from "./db.ts";
import type { Docs } from "./docs.ts";
import type { EditDoc } from "./editdoc.ts";
import { isRemoved, segments, toOutput, wordSpan } from "./editdoc.ts";
import { run } from "./lib/proc.ts";
import { findBoundaries, liveliness, readCurve, visualEvents } from "./lib/reference.ts";
import { probe } from "./lib/media.ts";
import type { MotionView } from "./motionlib.ts";
import type { Styles } from "./styles.ts";
import { STYLE_AREAS } from "./styles.ts";

/** How busy a finished video stays. Reported, never enforced: the reference sets what's right. */
export async function paceOf(path: string, signal?: AbortSignal) {
  const info = await probe(path);
  const curve = await readCurve(path, info.duration, { signal });
  const boundaries = findBoundaries(curve);
  return liveliness(curve, visualEvents(curve, boundaries), info.duration);
}

/** Cuts the kept words of a range out of the source, so the Motion agent sees and hears exactly that part. */
async function cutClip(doc: EditDoc, from: number, to: number, out: string) {
  const segs = segments(doc);
  const { start, end } = wordSpan(doc, segs, from, to);
  const parts = segs.map((s) => ({ a: Math.max(start, s.outStart), b: Math.min(end, s.outStart + s.end - s.start), s })).filter((p) => p.b - p.a > 0.02);
  const filters = parts.flatMap((p, i) => {
    const a = p.s.start + p.a - p.s.outStart;
    const b = p.s.start + p.b - p.s.outStart;
    return [`[0:v]trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`, `[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`];
  });
  filters.push(`${parts.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${parts.length}:v=1:a=1[v][a]`, `[v]scale=-2:720[small]`);
  await run(findBin("ffmpeg")!, ["-y", "-loglevel", "error", "-i", doc.source.path, "-filter_complex", filters.join(";"), "-map", "[small]", "-map", "[a]", "-c:v", "h264_videotoolbox", "-b:v", "3000k", "-c:a", "aac", out]);
  return { start, end };
}

/**
 * A chat can hand over what it measured from its attached references. Several can be attached;
 * the ones marked for motion or explainer graphics come first, then unmarked ones, newest first.
 */
function chatReferences(chat: ChatRow, into: string) {
  const root = join(chat.cwd, "work/reference");
  if (!existsSync(root)) return [];
  const found = readdirSync(root).map((name) => join(root, name)).filter((p) => existsSync(join(p, "facts.json"))).map((p) => {
    const meta = json<{ source?: string; use?: string[] }>(existsSync(join(p, "source.json")) ? readFileSync(join(p, "source.json"), "utf8") : null, {});
    return { dir: p, source: meta.source ?? null, use: meta.use ?? [], at: statSync(p).mtimeMs };
  });
  const forMotion = (u: string[]) => !u.length || u.includes("motion") || u.includes("explainer");
  return found.filter((r) => forMotion(r.use)).sort((x, y) => Number(y.use.length > 0) - Number(x.use.length > 0) || y.at - x.at).slice(0, 4).map((r, i) => {
    const rel = `reference/${i + 1}`;
    const dest = join(into, String(i + 1));
    mkdirSync(dest, { recursive: true });
    const files = readdirSync(r.dir).filter((f) => /\.(jpg|json)$/.test(f) && !/^f\d+\.jpg$/.test(f));
    for (const f of files) copyFileSync(join(r.dir, f), join(dest, f));
    return { rel, files: files.filter((f) => f.endsWith(".jpg")), source: r.source, use: r.use };
  });
}

export type MotionJob = { from: number; to: number; job: string; kind: "full_screen" | "overlay"; notes?: string };

/**
 * Packages one section for the Motion agent: the cut clip, its words with timing, the output it must
 * make, and the reference. The agent starts cold, so everything it needs lives in this folder.
 */
export type Example = { view: MotionView; loop: string | null; strip: string | null };

export async function writeBrief(chat: ChatRow, docs: Docs, styles: Styles, a: MotionJob, examples: Example[] = []) {
  const current = docs.latest(chat.id);
  if (!current) throw new Error("Open the footage first.");
  const { doc } = current;
  const id = randomUUID().slice(0, 8);
  const rel = `motion/briefs/${id}`;
  const dir = join(chat.cwd, rel);
  mkdirSync(dir, { recursive: true });
  const { start, end } = await cutClip(doc, a.from, a.to, join(dir, "section.mp4"));
  const segs = segments(doc);
  const words = doc.words.slice(a.from, a.to + 1).filter((w) => !isRemoved(doc, w.i)).map((w) => ({ text: w.text, start: Number((toOutput(segs, w.t0) - start).toFixed(3)), end: Number((toOutput(segs, w.t1) - start).toFixed(3)) }));
  const seconds = Number((end - start).toFixed(3));
  const output = `motion/out/${id}.${a.kind === "overlay" ? "mov" : "mp4"}`;
  mkdirSync(join(chat.cwd, "motion/out"), { recursive: true });

  const mission = json<Brief>(chat.mission, {});
  const lines: string[] = [];
  let referenceNote = "No motion reference was given for this video. Follow the motion-broll house style in $DOJO_MOTION_KIT/SKILL.md (Style defaults and Banned), and match the section's own look.";
  if (mission.styleId) {
    const pack = styles.referencePack(mission.styleId, join(dir, "reference"));
    const { measurements, rejected: _rejected, rules: _rules, ...card } = pack.style.card as Record<string, unknown>;
    writeFileSync(join(dir, "reference/style.json"), JSON.stringify(card, null, 1));
    writeFileSync(join(dir, "reference/measurements.json"), JSON.stringify(measurements ?? {}, null, 1));
    lines.push(`Style: ${pack.style.name}. Read reference/style.json and reference/measurements.json.`);
    for (const area of STYLE_AREAS) {
      const section = (card as Record<string, { summary?: string } | undefined>)[area.id];
      if (section?.summary) lines.push(`- ${area.label}: ${section.summary}`);
    }
    if (pack.files.length) lines.push(`Frame sequences to study in reference/: ${pack.files.join(", ")}. reference/moments.json says what each row shows. Each row is one moment, frame by frame, left to right.`);
    if (pack.source) lines.push(`The reference video itself: ${pack.source}`);
    referenceNote = lines.join("\n");
  } else {
    const packs = chatReferences(chat, join(dir, "reference"));
    for (const pack of packs) {
      const label = pack.use.length ? ` (marked for ${pack.use.join(", ")})` : "";
      lines.push(`### ${pack.rel}${label}`, `Read ${pack.rel}/facts.json for exact measurements.`);
      if (pack.files.length) lines.push(`Frame sequences to study in ${pack.rel}/: ${pack.files.join(", ")}. ${pack.rel}/moments.json says what each row shows. Each row is one moment, frame by frame, left to right.`);
      if (pack.source) lines.push(`The reference video itself: ${pack.source}`);
    }
    if (packs.length > 1) lines.unshift("There are several references. Take the look of every graphic (palette, type, objects, camera) from the ones marked for motion or explainer graphics, or else from the one that has designed graphics. A talking-head reference only sets type and timing.");
    if (packs.length) referenceNote = lines.join("\n");
  }

  // Saved animations the editor picked travel with the brief, so the agent can study them cold.
  let exampleNote = "";
  if (examples.length) {
    mkdirSync(join(dir, "examples"), { recursive: true });
    const notes = examples.map((e, i) => {
      const n = i + 1;
      if (e.loop && existsSync(e.loop)) copyFileSync(e.loop, join(dir, `examples/${n}.mp4`));
      if (e.strip && existsSync(e.strip)) copyFileSync(e.strip, join(dir, `examples/${n}.jpg`));
      writeFileSync(join(dir, `examples/${n}.json`), JSON.stringify({ name: e.view.name, summary: e.view.summary, operation: e.view.operation?.label, technique: e.view.technique?.label, spec: e.view.card.spec }, null, 1));
      return `${n}. ${e.view.name} (${[e.view.operation?.label, e.view.technique?.label].filter(Boolean).join(" → ")}): ${e.view.summary} See examples/${n}.mp4, examples/${n}.jpg (frames left to right) and examples/${n}.json (the rebuild spec).`;
    });
    exampleNote = `\n## Examples to follow\nThe editor picked these saved animations for this section. Rebuild their mechanism with this section's content, timing and words. Don't copy their subject.\n${notes.join("\n")}\n`;
  }

  writeFileSync(join(dir, "words.json"), JSON.stringify(words));
  writeFileSync(join(dir, "brief.md"), `# Motion brief ${id}

## The job
${a.job}
${a.notes ? `\n${a.notes}\n` : ""}
## What to make
- ${a.kind === "overlay" ? "A transparent clip that sits on top of the speaker, who stays visible. The video's captions keep running, so don't repeat the spoken words." : "A full-screen clip that replaces the picture. The speaker's voice carries on underneath. Captions are turned off across this clip, so any words the viewer should read belong in your design."}
- Exactly ${seconds} seconds, ${doc.output.width}x${doc.output.height}, ${doc.output.fps} fps. No audio.
- Save it to ${output} inside this mission.

## The section
- ${rel}/section.mp4 is the cut section, so you can see and hear what's being said.
- ${rel}/words.json has every word with its start and end in seconds from the start of your clip. Land each beat on its word.
- The line: "${words.map((w) => w.text).join(" ")}"

## The reference
${referenceNote}
${exampleNote}`);
  docs.apply(chat.id, [{ op: "reserve_graphic", id, from: a.from, to: a.to, label: a.job.slice(0, 60) }], `Waiting on the Motion agent: ${a.job.slice(0, 40)}`);
  return { id, brief: `${rel}/brief.md`, output, seconds, kind: a.kind };
}
