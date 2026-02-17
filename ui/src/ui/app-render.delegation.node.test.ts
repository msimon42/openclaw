import { describe, expect, it } from "vitest";
import { filterDelegationEventsForAgent } from "./app-render.ts";
import type { ObsEventRecord } from "../../../src/observability/stream-protocol.js";

function event(params: {
  id: string;
  type: string;
  agentId: string;
  traceId?: string;
  payload?: Record<string, unknown>;
}): ObsEventRecord {
  return {
    eventId: params.id,
    schemaVersion: "1.0",
    eventVersion: "1.0",
    timestamp: Date.now(),
    traceId: params.traceId ?? `trace-${params.id}`,
    agentId: params.agentId,
    eventType: params.type,
    payload: params.payload ?? {},
  };
}

describe("filterDelegationEventsForAgent", () => {
  it("keeps only delegation events and filters by selected agent id", () => {
    const events: ObsEventRecord[] = [
      event({ id: "1", type: "agent.call.start", agentId: "main", payload: { toAgentId: "worker" } }),
      event({ id: "2", type: "agent.message", agentId: "worker", payload: { fromAgentId: "main" } }),
      event({ id: "3", type: "artifact.publish", agentId: "research" }),
      event({ id: "4", type: "request.start", agentId: "main" }),
    ];

    const filtered = filterDelegationEventsForAgent(events, "main");
    expect(filtered.map((entry) => entry.eventId)).toEqual(["1", "2"]);
  });

  it("returns all delegation events when no agent is selected", () => {
    const events: ObsEventRecord[] = [
      event({ id: "1", type: "agent.call.end", agentId: "main" }),
      event({ id: "2", type: "artifact.fetch", agentId: "worker" }),
      event({ id: "3", type: "request.end", agentId: "worker" }),
    ];
    const filtered = filterDelegationEventsForAgent(events, null);
    expect(filtered.map((entry) => entry.eventId)).toEqual(["1", "2"]);
  });
});

