import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamedAuditEvent } from "../../packages/observability/src/index.js";
import {
  OBS_EVENT_EVENT,
  OBS_EVENT_SNAPSHOT,
  OBS_SCHEMA_VERSION,
  type ObsSubscribePayload,
} from "../observability/stream-protocol.js";
import { GatewayObservabilityStream } from "./observability-stream.js";

type BroadcastCall = {
  event: string;
  payload: unknown;
  connIds: string[];
};

function makeEvent(params: {
  eventId: string;
  traceId: string;
  timestamp: number;
  agentId: string;
  eventType: string;
}): StreamedAuditEvent {
  return {
    eventId: params.eventId,
    schemaVersion: "1.0",
    eventVersion: "1.0",
    timestamp: params.timestamp,
    traceId: params.traceId,
    agentId: params.agentId,
    eventType: params.eventType,
    payload: {},
  };
}

describe("GatewayObservabilityStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribe returns filtered snapshot and sends initial snapshot", async () => {
    let listener: ((event: StreamedAuditEvent) => void) | null = null;
    const broadcastCalls: BroadcastCall[] = [];

    const stream = new GatewayObservabilityStream({
      settings: {
        enabled: true,
        replayWindowMs: 300_000,
        serverMaxEventsPerSec: 50,
        serverMaxBufferedEvents: 10_000,
        messageMaxBytes: 65_536,
      },
      stream: {
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = null;
          };
        },
        getSnapshot: () => ({
          events: [
            makeEvent({
              eventId: "e-1",
              traceId: "trace-1",
              timestamp: Date.now() - 100,
              agentId: "agent-a",
              eventType: "tool.call.blocked",
            }),
            makeEvent({
              eventId: "e-2",
              traceId: "trace-2",
              timestamp: Date.now() - 50,
              agentId: "agent-b",
              eventType: "tool.call.end",
            }),
          ],
        }),
      },
      broadcastToConnIds: (event, payload, connIds) => {
        broadcastCalls.push({ event, payload, connIds: [...connIds] });
      },
      onDrop: () => {},
    });

    const params: ObsSubscribePayload = {
      schemaVersion: OBS_SCHEMA_VERSION,
      filters: {
        agentId: "agent-a",
        eventTypes: ["tool.call.blocked"],
      },
      maxEventsPerSec: 20,
    };

    const initial = stream.subscribe("conn-1", params);
    expect(initial.snapshot.events).toHaveLength(1);
    expect(initial.snapshot.events[0]?.eventId).toBe("e-1");

    stream.sendInitial("conn-1", initial);
    vi.runAllTicks();

    const snapshotEvent = broadcastCalls.find((entry) => entry.event === OBS_EVENT_SNAPSHOT);
    expect(snapshotEvent).toBeTruthy();
    expect(snapshotEvent?.connIds).toEqual(["conn-1"]);

    stream.close();
    expect(listener).toBeNull();
  });

  it("enforces per-connection rate limits", async () => {
    let listener: ((event: StreamedAuditEvent) => void) | null = null;
    const broadcastCalls: BroadcastCall[] = [];

    const stream = new GatewayObservabilityStream({
      settings: {
        enabled: true,
        replayWindowMs: 300_000,
        serverMaxEventsPerSec: 2,
        serverMaxBufferedEvents: 10_000,
        messageMaxBytes: 65_536,
      },
      stream: {
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = null;
          };
        },
        getSnapshot: () => ({ events: [] }),
      },
      broadcastToConnIds: (event, payload, connIds) => {
        broadcastCalls.push({ event, payload, connIds: [...connIds] });
      },
      onDrop: () => {},
    });

    stream.subscribe("conn-1", {
      schemaVersion: OBS_SCHEMA_VERSION,
      maxEventsPerSec: 1,
    });

    listener?.(
      makeEvent({
        eventId: "e-1",
        traceId: "trace-1",
        timestamp: Date.now(),
        agentId: "agent-a",
        eventType: "tool.call.start",
      }),
    );
    listener?.(
      makeEvent({
        eventId: "e-2",
        traceId: "trace-2",
        timestamp: Date.now(),
        agentId: "agent-a",
        eventType: "tool.call.end",
      }),
    );
    listener?.(
      makeEvent({
        eventId: "e-3",
        traceId: "trace-3",
        timestamp: Date.now(),
        agentId: "agent-a",
        eventType: "tool.call.end",
      }),
    );

    vi.runAllTicks();
    expect(broadcastCalls.filter((entry) => entry.event === OBS_EVENT_EVENT)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(broadcastCalls.filter((entry) => entry.event === OBS_EVENT_EVENT)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(broadcastCalls.filter((entry) => entry.event === OBS_EVENT_EVENT)).toHaveLength(3);

    stream.close();
  });

  it("unsubscribe stops stream delivery for a connection", async () => {
    let listener: ((event: StreamedAuditEvent) => void) | null = null;
    const broadcastCalls: BroadcastCall[] = [];

    const stream = new GatewayObservabilityStream({
      settings: {
        enabled: true,
        replayWindowMs: 300_000,
        serverMaxEventsPerSec: 50,
        serverMaxBufferedEvents: 10_000,
        messageMaxBytes: 65_536,
      },
      stream: {
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = null;
          };
        },
        getSnapshot: () => ({ events: [] }),
      },
      broadcastToConnIds: (event, payload, connIds) => {
        broadcastCalls.push({ event, payload, connIds: [...connIds] });
      },
      onDrop: () => {},
    });

    stream.subscribe("conn-1", { schemaVersion: OBS_SCHEMA_VERSION });
    stream.unsubscribe("conn-1");

    listener?.(
      makeEvent({
        eventId: "e-1",
        traceId: "trace-1",
        timestamp: Date.now(),
        agentId: "agent-a",
        eventType: "tool.call.start",
      }),
    );

    vi.runAllTicks();
    expect(broadcastCalls.filter((entry) => entry.event === OBS_EVENT_EVENT)).toHaveLength(0);

    stream.close();
  });
});
