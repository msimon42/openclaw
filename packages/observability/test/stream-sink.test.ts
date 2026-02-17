import { describe, expect, it } from "vitest";
import { StreamAuditSink } from "../src/audit/sinks/stream-sink.js";

describe("stream audit sink", () => {
  it("generates event ids and re-redacts payload values", async () => {
    const sink = new StreamAuditSink({ maxBufferedEvents: 10, replayWindowMs: 60_000 });
    sink.write({
      schemaVersion: "1.0",
      eventVersion: "1.0",
      timestamp: Date.now(),
      traceId: "trace-1",
      agentId: "main",
      eventType: "tool.call.start",
      payload: {
        prompt: "do not leak this prompt",
        authorization: "Bearer secret-token",
      },
    });

    const snapshot = sink.getSnapshot();
    expect(snapshot.events).toHaveLength(1);
    const first = snapshot.events[0];
    expect(first?.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.payload).toEqual({
      prompt: {
        hash: expect.any(String),
        length: 23,
      },
      authorization: "[REDACTED]",
    });
  });

  it("supports replay by timestamp and limit", () => {
    const sink = new StreamAuditSink({ maxBufferedEvents: 100, replayWindowMs: 60_000 });
    const baseTs = Date.now() - 1_000;
    for (let i = 0; i < 5; i += 1) {
      sink.write({
        schemaVersion: "1.0",
        eventVersion: "1.0",
        timestamp: baseTs + i,
        traceId: `trace-${i}`,
        agentId: "main",
        eventType: "model.call.end",
        payload: { index: i },
      });
    }

    const replay = sink.getSnapshot({ sinceTs: baseTs + 2, limit: 2 });
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0]?.payload).toEqual({ index: 3 });
    expect(replay.events[1]?.payload).toEqual({ index: 4 });
  });
});
