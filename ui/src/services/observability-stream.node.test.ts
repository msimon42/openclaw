import { describe, expect, it, vi } from "vitest";
import {
  OBS_EVENT_SNAPSHOT,
  OBS_METHOD_SUBSCRIBE,
  OBS_SCHEMA_VERSION,
} from "../../../src/observability/stream-protocol.js";
import { ObservabilityStreamService } from "./observability-stream.ts";

function makeEvent(id: string, timestamp: number) {
  return {
    eventId: id,
    schemaVersion: "1.0" as const,
    eventVersion: "1.0" as const,
    timestamp,
    traceId: `trace-${id}`,
    agentId: "main",
    eventType: "tool.call.end",
    payload: {},
  };
}

describe("ObservabilityStreamService", () => {
  it("reconnects, resubscribes with overlap, and dedupes replayed events", async () => {
    const request = vi.fn(async () => ({}));
    const client = { request };
    const service = new ObservabilityStreamService({ onUpdate: () => {} });

    service.attachClient(client as never);
    await service.handleHello({
      type: "hello-ok",
      protocol: 3,
      features: {
        methods: [OBS_METHOD_SUBSCRIBE],
        events: ["OBS.EVENT"],
      },
    });

    const now = Date.now();
    service.handleGatewayEvent({
      type: "event",
      event: OBS_EVENT_SNAPSHOT,
      payload: {
        schemaVersion: OBS_SCHEMA_VERSION,
        events: [makeEvent("A", now - 1000), makeEvent("B", now - 500)],
      },
    });

    service.handleDisconnected();
    await service.handleHello({
      type: "hello-ok",
      protocol: 3,
      features: {
        methods: [OBS_METHOD_SUBSCRIBE],
        events: ["OBS.EVENT"],
      },
    });

    service.handleGatewayEvent({
      type: "event",
      event: OBS_EVENT_SNAPSHOT,
      payload: {
        schemaVersion: OBS_SCHEMA_VERSION,
        events: [makeEvent("A", now - 1000), makeEvent("B", now - 500), makeEvent("C", now)],
      },
    });

    const ids = service
      .getStore()
      .getAllEvents()
      .map((event) => event.eventId)
      .toSorted();
    expect(ids).toEqual(["A", "B", "C"]);

    expect(request).toHaveBeenCalledTimes(2);
    const secondCall = request.mock.calls[1] as unknown[] | undefined;
    const secondPayload = secondCall?.[1] as { filters?: { sinceTs?: number } } | undefined;
    expect(typeof secondPayload?.filters?.sinceTs).toBe("number");
  });
});
