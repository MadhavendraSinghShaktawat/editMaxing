import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Chats } from "./claude/chat.ts";
import type { Database } from "./db.ts";
import { json } from "./db.ts";
import type { EditDoc, Op } from "./editdoc.ts";
import { analyzeTakes, applyOps, newDoc, segments, totalDuration, wordSpan, toOutput, isRemoved } from "./editdoc.ts";
import type { Files } from "./files.ts";
import type { JobContext, Jobs } from "./jobs.ts";
import { editDistance } from "./lib/dsa.ts";
import { probe } from "./lib/media.ts";
import { qualityCheck, render, toFcpxml, toSrt } from "./render.ts";
import type { Tools } from "./tools.ts";

type RenderJob = { chatId: string; preview: boolean; version?: number };

/** Every change saves a new version, so "go back to V3" is one call. */
export class Docs {
  private db: Database;
  private files: Files;
  private tools: Tools;
  private jobs: Jobs;
  private chats: () => Chats;

  constructor(db: Database, files: Files, tools: Tools, jobs: Jobs, chats: () => Chats) {
    this.db = db;
    this.files = files;
    this.tools = tools;
    this.jobs = jobs;
    this.chats = chats;
    jobs.register<RenderJob>("render", (p, ctx) => this.runRender(p, ctx));
  }

  latest(chatId: string) {
    const r = this.db.get<{ doc: string; version: number }>("SELECT doc, version FROM edit_docs WHERE chat_id = ? ORDER BY version DESC LIMIT 1", chatId);
    return r ? { doc: json<EditDoc>(r.doc, null as never), version: r.version } : null;
  }

  at(chatId: string, version: number) {
    const r = this.db.get<{ doc: string }>("SELECT doc FROM edit_docs WHERE chat_id = ? AND version = ?", chatId, version);
    if (!r) throw new Error(`There is no version ${version}.`);
    return json<EditDoc>(r.doc, null as never);
  }

  versions(chatId: string) {
    return this.db.all<{ version: number; note: string | null; created_at: number }>("SELECT version, note, created_at FROM edit_docs WHERE chat_id = ? ORDER BY version", chatId);
  }

  private save(chatId: string, doc: EditDoc, note: string) {
    const version = (this.latest(chatId)?.version ?? 0) + 1;
    this.db.run("INSERT INTO edit_docs (chat_id, version, doc, note, created_at) VALUES (?, ?, ?, ?, ?)", chatId, version, JSON.stringify(doc), note, Date.now());
    return version;
  }

  /** Accepts a mission file path, so Claude can open any footage attached to the chat. */
  async open(chatId: string, path: string, locale: string) {
    const stored = await this.files.adopt(path, path.split("/").pop()!.replace(/^[0-9a-f]{8}-/, ""));
    const info = await probe(stored.path);
    const transcript = await this.tools.transcribe(stored.hash, locale);
    const doc = newDoc({ hash: stored.hash, path: stored.path, name: stored.name, duration: info.duration, width: info.width, height: info.height, fps: info.fps, locale }, transcript.words);
    const version = this.save(chatId, doc, "Opened footage");
    return { version, ...this.summary(doc) };
  }

  apply(chatId: string, ops: Op[], note: string) {
    const current = this.latest(chatId);
    if (!current) throw new Error("Open the footage first.");
    const doc = applyOps(current.doc, ops);
    const version = this.save(chatId, doc, note);
    return { version, ...this.summary(doc) };
  }

  restore(chatId: string, version: number) {
    const doc = this.at(chatId, version);
    return { version: this.save(chatId, doc, `Restored V${version}`), ...this.summary(doc) };
  }

  summary(doc: EditDoc) {
    const segs = segments(doc);
    return { sourceSeconds: Number(doc.source.duration.toFixed(2)), outputSeconds: Number(totalDuration(segs).toFixed(2)), cuts: segs.length - 1, removedWords: doc.removed.reduce((n, [a, b]) => n + b - a + 1, 0), words: doc.words.length, broll: doc.broll.length, graphics: doc.graphics.length, sfx: doc.sfx.length, music: doc.music.length, captions: doc.captions.enabled, output: doc.output };
  }

  /** Compact view for Claude: numbered words, with cuts marked, and no timing noise. */
  view(chatId: string, from = 0, to = 100000) {
    const current = this.latest(chatId);
    if (!current) throw new Error("Open the footage first.");
    const { doc, version } = current;
    const segs = segments(doc);
    const text = doc.words.slice(from, to + 1).map((w) => (isRemoved(doc, w.i) ? `~${w.i}:${w.text}~` : `${w.i}:${w.text}`)).join(" ");
    const place = (o: { id: string; from: number; to: number; label?: string }) => ({ id: o.id, from: o.from, to: o.to, label: o.label, ...wordSpan(doc, segs, o.from, o.to) });
    return { version, ...this.summary(doc), transcript: text, broll: doc.broll.map(place), graphics: doc.graphics.map(place), sfx: doc.sfx.map((s) => ({ id: s.id, word: s.word, at: toOutput(segs, doc.words[s.word].t0) + s.offset, label: s.label })), keepPauses: doc.keepPauses, maxPause: doc.maxPause };
  }

  takes(chatId: string) {
    const current = this.latest(chatId);
    if (!current) throw new Error("Open the footage first.");
    return analyzeTakes(current.doc.words, editDistance);
  }

  /** Rendered files sit in the mission's out folder, one set per version. */
  outputs(chatId: string) {
    const dir = join(this.chats().row(chatId).cwd, "out");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  queueRender(chatId: string, preview: boolean, version?: number) {
    return this.jobs.run<{ path: string; version: number; quality: unknown; srt: string | null; fcpxml: string | null }>("render", { chatId, preview, version }, { lane: "heavy", priority: preview ? 3 : 5 });
  }

  private async runRender(p: RenderJob, ctx: JobContext) {
    const chat = this.chats().row(p.chatId);
    const current = this.latest(p.chatId);
    if (!current) throw new Error("Open the footage first.");
    const version = p.version ?? current.version;
    const doc = p.version ? this.at(p.chatId, p.version) : current.doc;
    const work = join(chat.cwd, "work", "render");
    const out = join(chat.cwd, "out");
    mkdirSync(work, { recursive: true });
    const stem = p.preview ? `V${version}-preview` : `V${version}`;
    const path = join(out, `${stem}.mp4`);
    await render(doc, path, work, { preview: p.preview, signal: ctx.signal, onProgress: (v) => ctx.progress(v, p.preview ? "Rendering a preview" : "Rendering") });
    if (p.preview) return { path, version, quality: null, srt: null, fcpxml: null };
    const quality = await qualityCheck(path, doc);
    const srt = join(out, `${stem}.srt`);
    const fcpxml = join(out, `${stem}.fcpxml`);
    writeFileSync(srt, toSrt(doc));
    writeFileSync(fcpxml, toFcpxml(doc, json<{ title?: string }>(chat.mission, {}).title ?? "Shifu Dojo"));
    return { path, version, quality, srt, fcpxml };
  }
}
