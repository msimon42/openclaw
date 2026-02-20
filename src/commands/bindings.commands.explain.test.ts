import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  requireValidConfig: vi.fn(),
}));

vi.mock("./agents.command-shared.js", () => ({
  requireValidConfig: (...args: unknown[]) =>
    (mocks.requireValidConfig as (...inner: unknown[]) => unknown)(...args),
}));

const { bindingsExplainCommand } = await import("./bindings.commands.explain.js");

function makeRuntime(): RuntimeEnv & {
  logs: string[];
  errors: string[];
  exitCode: number | null;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  return {
    logs,
    errors,
    exitCode,
    log: (...args: unknown[]) => logs.push(args.map((arg) => String(arg)).join(" ")),
    error: (...args: unknown[]) => errors.push(args.map((arg) => String(arg)).join(" ")),
    exit: (code: number): never => {
      exitCode = code;
      throw new Error(`exit ${code}`);
    },
  };
}

describe("bindings explain command", () => {
  it("returns deterministic JSON for specific binding matches", async () => {
    mocks.requireValidConfig.mockResolvedValue({
      agents: {
        list: [{ id: "main" }, { id: "worker" }],
      },
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
    });
    const runtime = makeRuntime();

    await bindingsExplainCommand(
      {
        channel: "telegram",
        account: "default",
        peer: "u1",
        peerKind: "direct",
        json: true,
      },
      runtime,
    );

    expect(runtime.logs).toHaveLength(1);
    const payload = JSON.parse(runtime.logs[0] ?? "{}") as {
      selectedAgentId: string;
      ruleId: string | null;
      specificity: number;
      fallback: { path: string };
    };
    expect(payload.selectedAgentId).toBe("worker");
    expect(payload.ruleId).toBe("binding:1");
    expect(payload.specificity).toBe(100);
    expect(payload.fallback.path).toContain("binding matched");
  });

  it("falls back to default agent when no binding matches", async () => {
    mocks.requireValidConfig.mockResolvedValue({
      agents: {
        list: [{ id: "main" }, { id: "worker" }],
      },
      bindings: [
        {
          agentId: "worker",
          match: {
            channel: "telegram",
          },
        },
      ],
    });
    const runtime = makeRuntime();

    await bindingsExplainCommand(
      {
        channel: "slack",
        account: "default",
        json: true,
      },
      runtime,
    );

    const payload = JSON.parse(runtime.logs[0] ?? "{}") as {
      selectedAgentId: string;
      ruleId: string | null;
      fallback: { defaultAgentId: string; path: string };
    };
    expect(payload.selectedAgentId).toBe("main");
    expect(payload.ruleId).toBeNull();
    expect(payload.fallback.defaultAgentId).toBe("main");
    expect(payload.fallback.path).toContain("default agent selected");
  });
});

