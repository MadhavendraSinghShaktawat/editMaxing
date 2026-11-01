import { randomUUID } from "node:crypto";
import type { Bus } from "./bus.ts";
import type { Database } from "./db.ts";
import { json } from "./db.ts";
import { Heap } from "./lib/dsa.ts";

/**
 * Heavy work runs one job at a time per Mac, so renders never fight each other.
 * The "claude" lane keeps background analysis from competing with live chats.
 */
const LANES = { heavy: 1, light: 3, claude: 1 } as const;
export type Lane = keyof typeof LANES;

export type JobContext = {
  id: string;
  signal: AbortSignal;
  progress: (value: number, message?: string) => void;
};
export type JobHandler = (payload: never, ctx: JobContext) => Promise<unknown>;

type Queued = { id: string; kind: string; lane: Lane; priority: number; order: number; payload: unknown; resolve?: (v: unknown) => void; reject?: (e: Error) => void };

export class Jobs {
  private db: Database;
  private bus: Bus;
  private handlers = new Map<string, JobHandler>();
  private queues = new Map<Lane, Heap<Queued>>();
  private running = new Map<Lane, Map<string, AbortController>>();
  private order = 0;

  constructor(db: Database, bus: Bus) {
    this.db = db;
    this.bus = bus;
    for (const lane of Object.keys(LANES) as Lane[]) {
      this.queues.set(lane, new Heap<Queued>((a, b) => (a.priority - b.priority || a.order - b.order) < 0));
      this.running.set(lane, new Map());
    }
  }

  register<T>(kind: string, handler: (payload: T, ctx: JobContext) => Promise<unknown>) {
    this.handlers.set(kind, handler as JobHandler);
  }

  /** Requeues work that was interrupted by a restart. Only resumable kinds are retried. */
  resume(kinds: string[]) {
    const rows = this.db.all<{ id: string; kind: string; resource: Lane; priority: number; payload: string }>("SELECT id, kind, resource, priority, payload FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at");
    for (const r of rows) {
      if (kinds.includes(r.kind)) this.enqueue({ id: r.id, kind: r.kind, lane: r.resource, priority: r.priority, order: this.order++, payload: json(r.payload, {}) });
      else this.finish(r.id, "failed", null, "Interrupted by a restart");
    }
    this.pump();
  }

  private insert(kind: string, payload: unknown, lane: Lane, priority: number) {
    const id = randomUUID();
    const now = Date.now();
    this.db.run("INSERT INTO jobs (id, kind, status, priority, resource, payload, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)", id, kind, priority, lane, JSON.stringify(payload), now, now);
    this.bus.emit("job", { id, kind, status: "queued", progress: 0 });
    return id;
  }

  /** Queues a job and returns its id immediately. */
  add(kind: string, payload: unknown, options: { lane?: Lane; priority?: number } = {}) {
    const lane = options.lane ?? "heavy";
    const priority = options.priority ?? 5;
    const id = this.insert(kind, payload, lane, priority);
    this.enqueue({ id, kind, lane, priority, order: this.order++, payload });
    this.pump();
    return id;
  }

  /** Queues a job and resolves with its result. */
  run<T>(kind: string, payload: unknown, options: { lane?: Lane; priority?: number } = {}) {
    const lane = options.lane ?? "heavy";
    const priority = options.priority ?? 5;
    const id = this.insert(kind, payload, lane, priority);
    return new Promise<T>((resolve, reject) => {
      this.enqueue({ id, kind, lane, priority, order: this.order++, payload, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  private enqueue(job: Queued) {
    this.queues.get(job.lane)!.push(job);
  }

  cancel(id: string) {
    for (const lane of Object.keys(LANES) as Lane[]) {
      this.running.get(lane)!.get(id)?.abort();
      if (this.queues.get(lane)!.remove((j) => j.id === id)) this.finish(id, "cancelled", null, null);
    }
  }

  active(lane: Lane) {
    return this.running.get(lane)!.size + this.queues.get(lane)!.size;
  }

  private pump() {
    for (const lane of Object.keys(LANES) as Lane[]) {
      const slots = this.running.get(lane)!;
      const queue = this.queues.get(lane)!;
      while (slots.size < LANES[lane] && queue.size) void this.start(queue.pop()!);
    }
  }

  private async start(job: Queued) {
    const controller = new AbortController();
    this.running.get(job.lane)!.set(job.id, controller);
    this.db.run("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?", Date.now(), job.id);
    this.bus.emit("job", { id: job.id, kind: job.kind, status: "running", progress: 0 });
    let last = 0;
    const ctx: JobContext = {
      id: job.id,
      signal: controller.signal,
      progress: (value, message) => {
        const now = Date.now();
        if (now - last < 150 && value < 1) return;
        last = now;
        this.db.run("UPDATE jobs SET progress = ?, message = ?, updated_at = ? WHERE id = ?", value, message ?? null, now, job.id);
        this.bus.emit("job", { id: job.id, kind: job.kind, status: "running", progress: value, message });
      },
    };
    try {
      const handler = this.handlers.get(job.kind);
      if (!handler) throw new Error(`No handler for ${job.kind}`);
      const result = await handler(job.payload as never, ctx);
      this.finish(job.id, "done", result, null);
      job.resolve?.(result);
    } catch (e) {
      const error = e as Error;
      this.finish(job.id, controller.signal.aborted ? "cancelled" : "failed", null, error.message);
      job.reject?.(error);
    } finally {
      this.running.get(job.lane)!.delete(job.id);
      this.pump();
    }
  }

  private finish(id: string, status: string, result: unknown, error: string | null) {
    const progress = status === "done" ? 1 : null;
    this.db.run("UPDATE jobs SET status = ?, result = ?, error = ?, progress = COALESCE(?, progress), updated_at = ? WHERE id = ?", status, result === null ? null : JSON.stringify(result ?? null), error, progress, Date.now(), id);
    const kind = this.db.get<{ kind: string }>("SELECT kind FROM jobs WHERE id = ?", id)?.kind;
    this.bus.emit("job", { id, kind, status, progress: progress ?? undefined, result, error });
  }
}
