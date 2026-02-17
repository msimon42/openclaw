import { describe, expect, it } from "vitest";
import { getTraceContext, runWithTraceContext } from "../src/trace/trace-context.js";
import { createChildSpan, createRootTrace } from "../src/trace/trace.js";

describe("trace context", () => {
  it("propagates traceId across child spans", () => {
    const root = createRootTrace({ requestId: "req-1", agentId: "agent-1" });
    let seenTraceId = "";

    runWithTraceContext(root, () => {
      const current = getTraceContext();
      seenTraceId = current?.traceId ?? "";
      const child = createChildSpan(root);
      expect(child.traceId).toBe(root.traceId);
      expect(child.spanId).not.toBe(root.spanId);
    });

    expect(seenTraceId).toBe(root.traceId);
  });
});
