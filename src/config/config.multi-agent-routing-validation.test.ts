import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./config.js";

describe("multi-agent routing validation", () => {
  it("rejects bindings that reference unknown agents", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "main" }] },
      bindings: [
        {
          agentId: "worker",
          match: { channel: "telegram" },
        },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path.includes("bindings.0.agentId"))).toBe(true);
    }
  });

  it("warns on ambiguous overlapping bindings", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "main" }, { id: "worker" }, { id: "social" }] },
      bindings: [
        {
          agentId: "worker",
          match: { channel: "telegram", accountId: "default" },
        },
        {
          agentId: "social",
          match: { channel: "telegram", accountId: "default" },
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings.some((warning) => warning.message.includes("ambiguous binding overlap"))).toBe(
        true,
      );
    }
  });

  it("warns on risky dmScope=main for multi-channel/multi-account bindings", () => {
    const res = validateConfigObjectWithPlugins({
      session: { dmScope: "main" },
      agents: { list: [{ id: "main" }, { id: "worker" }] },
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "acct-a" } },
        { agentId: "worker", match: { channel: "slack", accountId: "acct-b" } },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings.some((warning) => warning.path === "session.dmScope")).toBe(true);
    }
  });

  it("warns when multiple agents share the same workspace directory", () => {
    const shared = "/tmp/openclaw-shared-workspace";
    const res = validateConfigObjectWithPlugins({
      agents: {
        list: [
          { id: "main", workspace: shared },
          { id: "worker", workspace: shared },
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(
        res.warnings.some((warning) =>
          warning.message.includes("share the same workspace directory"),
        ),
      ).toBe(true);
    }
  });
});

