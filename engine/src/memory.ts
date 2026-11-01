import { randomUUID } from "node:crypto";
import type { Bus } from "./bus.ts";
import type { Database } from "./db.ts";
import { json } from "./db.ts";

const STOP = new Set(["the", "and", "for", "this", "that", "with", "you", "your", "please", "can", "could", "just", "make", "want", "need", "should", "will", "use", "are", "was", "have", "has", "from", "too", "very", "more", "less"]);
const CORRECTION = /\b(don'?t|do not|no more|stop|never|always|avoid|less|fewer|more|too|instead|remove|shorter|longer|slower|faster|smaller|bigger)\b/i;

export const tokens = (text: string) => [...new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))];

export function similarity(a: string[], b: string[]) {
  const set = new Set(a);
  const shared = b.filter((w) => set.has(w)).length;
  return shared / (a.length + b.length - shared || 1);
}

export const looksLikeCorrection = (text: string) => CORRECTION.test(text) && text.length < 300;

/** Learns only from what the user says. Text inside footage or references can never become a rule. */
export class Memory {
  private db: Database;
  private bus: Bus;

  constructor(db: Database, bus: Bus) {
    this.db = db;
    this.bus = bus;
  }

  rules() {
    return this.db.all<{ id: string; text: string; mode: string | null; status: string; evidence: string | null; created_at: number }>("SELECT * FROM memory_rules WHERE status != 'removed' ORDER BY created_at DESC").map((r) => ({ id: r.id, text: r.text, mode: r.mode, status: r.status, evidence: json<string[]>(r.evidence, []) }));
  }

  activeFor(mode: string | null) {
    return this.rules().filter((r) => r.status === "active" && (!r.mode || r.mode === mode)).map((r) => r.text);
  }

  /** The second similar correction becomes a saved rule. */
  note(text: string, chatId: string, mode: string | null) {
    if (!looksLikeCorrection(text)) return null;
    const words = tokens(text);
    if (words.length < 2) return null;
    const past = this.db.all<{ text: string; tokens: string }>("SELECT text, tokens FROM corrections ORDER BY id DESC LIMIT 200");
    this.db.run("INSERT INTO corrections (text, tokens, chat_id, created_at) VALUES (?, ?, ?, ?)", text, JSON.stringify(words), chatId, Date.now());
    const match = past.find((p) => similarity(words, json<string[]>(p.tokens, [])) >= 0.5);
    if (!match) return null;
    if (this.rules().some((r) => similarity(tokens(r.text), words) >= 0.5)) return null;
    const id = randomUUID();
    this.db.run("INSERT INTO memory_rules (id, text, mode, evidence, created_at) VALUES (?, ?, ?, ?, ?)", id, text, mode, JSON.stringify([match.text, text]), Date.now());
    const rule = this.rules().find((r) => r.id === id)!;
    this.bus.emit("memory", rule);
    return rule;
  }

  update(id: string, text: string) {
    this.db.run("UPDATE memory_rules SET text = ? WHERE id = ?", text, id);
  }

  remove(id: string) {
    this.db.run("UPDATE memory_rules SET status = 'removed' WHERE id = ?", id);
  }
}
