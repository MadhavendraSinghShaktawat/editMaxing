import type { ServerResponse } from "node:http";

/** Who may receive an event: everyone, admins only, or a list of member ids. */
export type Audience = "*" | "admins" | string[];
export type DojoEvent = { seq: number; type: string; data: unknown; to: Audience };
export type Listener = { memberId: string; admin: boolean };

const KEEP = 2000;

export const reaches = (to: Audience, who: Listener) => to === "*" || (to === "admins" ? who.admin : to.includes(who.memberId));

/**
 * Server-sent events with a ring buffer, so a reconnecting client misses nothing.
 * Every event has an audience. A teammate's stream only ever carries their own work.
 */
export class Bus {
  private seq = 0;
  private ring: DojoEvent[] = [];
  private clients = new Map<ServerResponse, Listener>();
  private listeners = new Set<(e: DojoEvent) => void>();
  /** Works out the audience for events emitted without one. Set once at startup. */
  audience: (type: string, data: unknown) => Audience = () => "admins";

  emit(type: string, data: unknown, to?: Audience) {
    const event = { seq: ++this.seq, type, data, to: to ?? this.audience(type, data) };
    this.ring.push(event);
    if (this.ring.length > KEEP) this.ring.shift();
    const frame = `id: ${event.seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [c, who] of this.clients) if (reaches(event.to, who)) c.write(frame);
    for (const fn of this.listeners) fn(event);
  }

  on(fn: (e: DojoEvent) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  attach(res: ServerResponse, lastSeq: number, who: Listener) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`retry: 1500\n\n`);
    if (lastSeq > 0) {
      for (const e of this.ring) {
        if (e.seq > lastSeq && reaches(e.to, who)) res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
      }
    }
    this.clients.set(res, who);
    const beat = setInterval(() => res.write(": ping\n\n"), 20000);
    res.on("close", () => {
      clearInterval(beat);
      this.clients.delete(res);
    });
  }

  /** Ends the live streams of a member whose access was just taken away. */
  drop(memberId: string) {
    for (const [c, who] of this.clients) {
      if (who.memberId === memberId) {
        c.end();
        this.clients.delete(c);
      }
    }
  }

  get connected() {
    return this.clients.size;
  }
}
