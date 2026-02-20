import { createHash } from "node:crypto";
import type { AuditSink, SerializedAuditEvent } from "../audit-types.js";
import { redactAuditEvent } from "../audit-redaction.js";

export type StreamedAuditEvent = SerializedAuditEvent & {
  eventId: string;
};

export type StreamAuditSinkOptions = {
  maxBufferedEvents?: number;
  replayWindowMs?: number;
};

export type StreamAuditSnapshotParams = {
  sinceTs?: number;
  limit?: number;
};

export type StreamAuditSnapshot = {
  events: StreamedAuditEvent[];
  fromTs?: number;
  toTs?: number;
};

export class StreamAuditSink implements AuditSink {
  private readonly maxBufferedEvents: number;
  private readonly replayWindowMs: number;
  private readonly listeners = new Set<(event: StreamedAuditEvent) => void>();
  private readonly ring: StreamedAuditEvent[] = [];
  private counter = 0;

  constructor(options?: StreamAuditSinkOptions) {
    this.maxBufferedEvents = Math.max(1, options?.maxBufferedEvents ?? 10_000);
    this.replayWindowMs = Math.max(1_000, options?.replayWindowMs ?? 300_000);
  }

  private nextEventId(event: SerializedAuditEvent): string {
    const counter = this.counter++;
    return createHash("sha256")
      .update(
        `${event.traceId}:${event.timestamp}:${event.eventType}:${event.agentId}:${counter}`,
        "utf8",
      )
      .digest("hex");
  }

  private prune(now: number) {
    const minTs = now - this.replayWindowMs;
    while (this.ring.length > 0) {
      const oldest = this.ring[0];
      if (!oldest) {
        break;
      }
      if (this.ring.length <= this.maxBufferedEvents && oldest.timestamp >= minTs) {
        break;
      }
      this.ring.shift();
    }
  }

  write(event: SerializedAuditEvent): void {
    // Re-apply strict redaction at stream boundary before any in-memory fanout.
    const safeEvent = redactAuditEvent(event, { mode: "strict" });
    const streamed: StreamedAuditEvent = {
      ...safeEvent,
      eventId: this.nextEventId(safeEvent),
    };
    const now = Date.now();
    this.ring.push(streamed);
    this.prune(now);
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        try {
          listener(streamed);
        } catch {
          // Listener failures must not affect runtime execution.
        }
      });
    }
  }

  getSnapshot(params?: StreamAuditSnapshotParams): StreamAuditSnapshot {
    const now = Date.now();
    this.prune(now);
    const sinceTs =
      typeof params?.sinceTs === "number" && Number.isFinite(params.sinceTs)
        ? Math.max(0, Math.floor(params.sinceTs))
        : undefined;
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.max(1, Math.floor(params.limit))
        : undefined;

    const filtered = this.ring.filter((event) => (sinceTs ? event.timestamp >= sinceTs : true));
    const events = limit ? filtered.slice(Math.max(0, filtered.length - limit)) : filtered;
    return {
      events: structuredClone(events),
      fromTs: events[0]?.timestamp,
      toTs: events[events.length - 1]?.timestamp,
    };
  }

  subscribe(listener: (event: StreamedAuditEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
