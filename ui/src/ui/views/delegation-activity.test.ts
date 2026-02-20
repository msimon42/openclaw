import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { ObsEventRecord } from "../../../../src/observability/stream-protocol.js";
import { renderDelegationActivity } from "./delegation-activity.ts";

function makeEvent(params: {
  eventId: string;
  eventType: string;
  traceId: string;
  agentId: string;
  payload?: Record<string, unknown>;
  timestamp?: number;
}): ObsEventRecord {
  return {
    eventId: params.eventId,
    schemaVersion: "1.0",
    eventVersion: "1.0",
    timestamp: params.timestamp ?? Date.now(),
    traceId: params.traceId,
    agentId: params.agentId,
    eventType: params.eventType,
    payload: params.payload ?? {},
  };
}

describe("renderDelegationActivity", () => {
  it("groups activity rows by trace id", async () => {
    const container = document.createElement("div");
    const baseTs = Date.now();
    render(
      renderDelegationActivity({
        events: [
          makeEvent({
            eventId: "1",
            eventType: "agent.call.start",
            traceId: "trace-a",
            agentId: "main",
            payload: { fromAgentId: "main", toAgentId: "worker" },
            timestamp: baseTs,
          }),
          makeEvent({
            eventId: "2",
            eventType: "agent.call.end",
            traceId: "trace-a",
            agentId: "main",
            payload: { status: "ok", artifactIds: ["art_1"] },
            timestamp: baseTs + 10,
          }),
          makeEvent({
            eventId: "3",
            eventType: "agent.message",
            traceId: "trace-b",
            agentId: "social",
            payload: { fromAgentId: "social", toAgentId: "research" },
            timestamp: baseTs + 20,
          }),
        ],
        traceFilter: "",
        onTraceFilterChange: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("trace-a");
    expect(container.textContent).toContain("trace-b");
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
  });

  it("applies trace filter to the rendered rows", async () => {
    const container = document.createElement("div");
    render(
      renderDelegationActivity({
        events: [
          makeEvent({
            eventId: "1",
            eventType: "agent.call.start",
            traceId: "trace-keep",
            agentId: "main",
          }),
          makeEvent({
            eventId: "2",
            eventType: "agent.call.start",
            traceId: "trace-drop",
            agentId: "main",
          }),
        ],
        traceFilter: "keep",
        onTraceFilterChange: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("trace-keep");
    expect(container.textContent).not.toContain("trace-drop");
  });

  it("tolerates compacted/truncated marker strings in delegation payloads", async () => {
    const container = document.createElement("div");
    render(
      renderDelegationActivity({
        events: [
          makeEvent({
            eventId: "1",
            eventType: "agent.call.end",
            traceId: "trace-markers",
            agentId: "main",
            payload: {
              fromAgentId: "main",
              toAgentId: "worker",
              status: "[compacted: tool output removed to free context]",
              note: "[truncated: output exceeded context limit]",
            },
          }),
        ],
        traceFilter: "",
        onTraceFilterChange: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("trace-markers");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });
});
