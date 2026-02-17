import { describe, expect, it } from "vitest";
import { groupTraceEvents, matchesAuditFilter, ObservabilityStore } from "./observability-store.ts";

function makeEvent(params: {
  eventId: string;
  traceId: string;
  timestamp: number;
  agentId: string;
  eventType: string;
  decision?: "allow" | "deny";
}) {
  return {
    eventId: params.eventId,
    schemaVersion: "1.0" as const,
    eventVersion: "1.0" as const,
    timestamp: params.timestamp,
    traceId: params.traceId,
    agentId: params.agentId,
    eventType: params.eventType,
    decision: params.decision
      ? {
          outcome: params.decision,
          reason: "test",
        }
      : undefined,
    payload: {},
  };
}

describe("observability store filters", () => {
  it("filters by agentId and decision outcome", () => {
    const allow = makeEvent({
      eventId: "a",
      traceId: "trace-1",
      timestamp: 10,
      agentId: "agent-a",
      eventType: "policy.decision",
      decision: "allow",
    });
    const deny = makeEvent({
      eventId: "b",
      traceId: "trace-2",
      timestamp: 20,
      agentId: "agent-b",
      eventType: "policy.decision",
      decision: "deny",
    });

    expect(matchesAuditFilter(allow, { agentId: "agent-a", decisionOutcome: "allow" })).toBe(true);
    expect(matchesAuditFilter(deny, { agentId: "agent-a", decisionOutcome: "allow" })).toBe(false);
  });

  it("groups trace events in timestamp order", () => {
    const events = [
      makeEvent({
        eventId: "c",
        traceId: "trace-1",
        timestamp: 300,
        agentId: "agent-a",
        eventType: "model.call.end",
      }),
      makeEvent({
        eventId: "d",
        traceId: "trace-1",
        timestamp: 100,
        agentId: "agent-a",
        eventType: "model.call.start",
      }),
      makeEvent({
        eventId: "e",
        traceId: "trace-2",
        timestamp: 200,
        agentId: "agent-a",
        eventType: "tool.call.start",
      }),
    ];

    const grouped = groupTraceEvents(events, "trace-1");
    expect(grouped.map((event) => event.eventId)).toEqual(["d", "c"]);
  });

  it("deduplicates event ids", () => {
    const store = new ObservabilityStore(100);
    const event = makeEvent({
      eventId: "dup-1",
      traceId: "trace-1",
      timestamp: 100,
      agentId: "agent-a",
      eventType: "tool.call.start",
    });

    expect(store.addEvent(event)).toBe(true);
    expect(store.addEvent(event)).toBe(false);
    expect(store.getAllEvents()).toHaveLength(1);
  });
});
