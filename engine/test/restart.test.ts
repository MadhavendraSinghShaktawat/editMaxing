import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bus } from "../src/bus.ts";
import { CONTINUE_PROMPT, MAX_RESTART_CONTINUATIONS, continuationText, recentRestarts } from "../src/claude/chat.ts";
import { Database } from "../src/db.ts";
import { Jobs } from "../src/jobs.ts";

test("a cut-off turn continues with T3 Code's wording, and lost Motion work is named", () => {
  assert.equal(continuationText([]), CONTINUE_PROMPT);
  assert.match(CONTINUE_PROMPT, /^Continue where you left off\. Your last turn was cut short/);
  const text = continuationText([{ description: "Build motion/briefs/ab12/brief.md" }, { description: "" }]);
  assert.match(text, /^Note: Shifu Dojo restarted, and this background work was cancelled before it finished\./);
  assert.match(text, /- subagent: Motion agent \(Build motion\/briefs\/ab12\/brief\.md\)/);
  assert.ok(text.endsWith(CONTINUE_PROMPT));
  assert.match(continuationText(Array.from({ length: 13 }, () => ({ description: "x" }))), /- and 3 more/);
});

test("a chat that keeps restarting stops continuing by itself after 3 times in 5 minutes", () => {
  const now = 1_000_000_000;
  assert.equal(recentRestarts([now - 60_000, now - 120_000, now - 10 * 60_000], now).length, 2, "older restarts don't count");
  assert.ok(recentRestarts([now - 1, now - 2, now - 3], now).length >= MAX_RESTART_CONTINUATIONS);
});

test("work someone was waiting on is closed after a restart, so nothing shows as running forever", () => {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "dojo-restart-")), "dojo.db"));
  const now = Date.now();
  for (const [id, kind] of [["r1", "render"], ["l1", "link.fetch"]]) db.run("INSERT INTO jobs (id, kind, status, priority, resource, payload, created_at, updated_at) VALUES (?, ?, 'running', 5, 'heavy', '{}', ?, ?)", id, kind, now, now);
  const jobs = new Jobs(db, new Bus());
  jobs.register("link.fetch", async () => new Promise(() => {}));
  jobs.resume(["link.fetch"]);
  assert.equal(db.get<{ status: string }>("SELECT status FROM jobs WHERE id = 'r1'")!.status, "cancelled");
  assert.notEqual(db.get<{ status: string }>("SELECT status FROM jobs WHERE id = 'l1'")!.status, "cancelled", "resumable work carries on");
});
