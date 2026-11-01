import type { ServerResponse } from "node:http";

export type DojoEvent = { seq: number; type: string; data: unknown };

const KEEP = 2000;

/** Server-sent events with a ring buffer, so a reconnecting client misses nothing. */
export class Bus {
  private seq = 0;
  private ring: DojoEvent[] = [];
  private clients = new Set<ServerResponse>();
  private listeners = new Set<(e: DojoEvent) => void>();

  emit(type: string, data: unknown) {
    const event = { seq: ++this.seq, type, data };
    this.ring.push(event);
    if (this.ring.length > KEEP) this.ring.shift();
    const frame = `id: ${event.seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(frame);
    for (const fn of this.listeners) fn(event);
  }

  on(fn: (e: DojoEvent) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  attach(res: ServerResponse, lastSeq: number) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`retry: 1500\n\n`);
    if (lastSeq > 0) {
      for (const e of this.ring) {
        if (e.seq > lastSeq) res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
      }
    }
    this.clients.add(res);
    const beat = setInterval(() => res.write(": ping\n\n"), 20000);
    res.on("close", () => {
      clearInterval(beat);
      this.clients.delete(res);
    });
  }

  get connected() {
    return this.clients.size;
  }
}
