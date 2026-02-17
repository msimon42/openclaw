import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  observeRoutingDecision: vi.fn(),
}));

vi.mock("../infra/observability.js", () => ({
  observeRoutingDecision: (...args: unknown[]) =>
    (mocks.observeRoutingDecision as (...inner: unknown[]) => unknown)(...args),
}));

const { resolveAgentRoute } = await import("./resolve-route.js");

describe("resolveAgentRoute observability", () => {
  it("emits routing.decision payload with selected agent, rule, and specificity", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "worker",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "direct", id: "u1" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "direct", id: "u1" },
    });

    expect(route.agentId).toBe("worker");
    expect(mocks.observeRoutingDecision).toHaveBeenCalledTimes(1);
    const [payload] = mocks.observeRoutingDecision.mock.calls[0] as [Record<string, unknown>];
    expect(payload.selectedAgentId).toBe("worker");
    expect(payload.ruleId).toBe("binding:1");
    expect(payload.specificity).toBe(100);
    expect(payload.channel).toBe("telegram");
    expect(payload.account).toBe("default");
  });
});

