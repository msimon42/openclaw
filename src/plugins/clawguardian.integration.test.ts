import { describe, expect, it, vi } from "vitest";
import type {
  OpenClawPluginApi,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookHandlerMap,
  PluginHookToolContext,
  PluginLogger,
} from "./types.js";
import registerClawGuardian from "../../extensions/clawguardian/index.js";

type CapturedLogs = {
  info: string[];
  warn: string[];
  error: string[];
  debug: string[];
  logger: PluginLogger;
};

type ParsedAuditEvent = {
  decision: "allow" | "deny" | "require_approval";
  toolName: string;
  riskTier: "low" | "medium" | "high" | "critical";
  reason?: string;
  payload?: Record<string, unknown>;
};

type ClawGuardianHarness = {
  logs: CapturedLogs;
  enqueueSystemEvent: ReturnType<typeof vi.fn>;
  invoke: (params: {
    toolName: string;
    toolParams: Record<string, unknown>;
    ctx?: Pick<PluginHookToolContext, "agentId" | "sessionKey">;
  }) => Promise<PluginHookBeforeToolCallResult | undefined>;
};

function createCapturedLogger(): CapturedLogs {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const debug: string[] = [];
  return {
    info,
    warn,
    error,
    debug,
    logger: {
      info: (message: string) => info.push(message),
      warn: (message: string) => warn.push(message),
      error: (message: string) => error.push(message),
      debug: (message: string) => debug.push(message),
    },
  };
}

function parseAuditEvents(infoLogs: string[]): ParsedAuditEvent[] {
  const prefix = "[clawguardian:audit] ";
  const out: ParsedAuditEvent[] = [];
  for (const line of infoLogs) {
    if (!line.startsWith(prefix)) {
      continue;
    }
    const raw = line.slice(prefix.length);
    try {
      out.push(JSON.parse(raw) as ParsedAuditEvent);
    } catch {
      // ignore malformed entries in tests
    }
  }
  return out;
}

function createHarness(pluginConfig: Record<string, unknown>): ClawGuardianHarness {
  const logs = createCapturedLogger();
  const enqueueSystemEvent = vi.fn();
  let beforeToolCallHook: PluginHookHandlerMap["before_tool_call"] | undefined;

  const api: OpenClawPluginApi = {
    id: "clawguardian",
    name: "ClawGuardian",
    source: "test",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig,
    runtime: {
      system: {
        enqueueSystemEvent,
      },
    } as OpenClawPluginApi["runtime"],
    logger: logs.logger,
    registerTool: () => undefined,
    registerHook: () => undefined,
    registerHttpHandler: () => undefined,
    registerHttpRoute: () => undefined,
    registerChannel: () => undefined,
    registerGatewayMethod: () => undefined,
    registerCli: () => undefined,
    registerService: () => undefined,
    registerProvider: () => undefined,
    registerCommand: () => undefined,
    resolvePath: (input: string) => input,
    on: (hookName, handler) => {
      if (hookName === "before_tool_call") {
        beforeToolCallHook = handler as PluginHookHandlerMap["before_tool_call"];
      }
    },
  };

  registerClawGuardian(api);

  return {
    logs,
    enqueueSystemEvent,
    invoke: async ({ toolName, toolParams, ctx }) => {
      if (!beforeToolCallHook) {
        return undefined;
      }
      const event: PluginHookBeforeToolCallEvent = {
        toolName,
        params: toolParams,
      };
      return await beforeToolCallHook(event, {
        toolName,
        agentId: ctx?.agentId,
        sessionKey: ctx?.sessionKey,
      });
    },
  };
}

describe("clawguardian plugin integration", () => {
  it("does not enforce policies when plugin config is disabled", async () => {
    const harness = createHarness({
      enabled: false,
      policy: {
        allow: ["network.fetch"],
        allowDomains: ["example.com"],
      },
    });

    const outcome = await harness.invoke({
      toolName: "web_fetch",
      toolParams: { url: "https://evil.example.net/path" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(outcome).toBeUndefined();
    expect(
      harness.logs.info.some((line) => line.includes("[clawguardian] disabled by config")),
    ).toBe(true);
    expect(parseAuditEvents(harness.logs.info)).toHaveLength(0);
  });

  it("blocks disallowed tool call and emits deny audit event", async () => {
    const harness = createHarness({
      policy: {
        allow: ["network.fetch"],
        allowDomains: ["example.com"],
      },
    });

    const outcome = await harness.invoke({
      toolName: "web_fetch",
      toolParams: { url: "https://evil.example.net/path" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(outcome?.block).toBe(true);
    expect(outcome?.blockReason).toContain("ClawGuardian blocked tool call");
    const audits = parseAuditEvents(harness.logs.info);
    const last = audits.at(-1);
    expect(last?.decision).toBe("deny");
    expect(last?.toolName).toBe("web_fetch");
    expect(last?.reason).toContain("network.fetch denied");
  });

  it("blocks network calls when no domain can be inferred", async () => {
    const harness = createHarness({
      policy: {
        allow: ["network.fetch"],
        allowDomains: ["example.com"],
      },
    });

    const outcome = await harness.invoke({
      toolName: "web_fetch",
      toolParams: { query: "fetch weather without url" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(outcome?.block).toBe(true);
    expect(outcome?.blockReason).toContain("no domain could be resolved");
    const audits = parseAuditEvents(harness.logs.info);
    const last = audits.at(-1);
    expect(last?.decision).toBe("deny");
    expect(last?.payload?.stage).toBe("policy");
  });

  it("allows tool call and emits allow audit event", async () => {
    const harness = createHarness({
      policy: {
        allow: ["network.fetch"],
        allowDomains: ["example.com"],
      },
    });

    const outcome = await harness.invoke({
      toolName: "web_fetch",
      toolParams: { url: "https://example.com/docs" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(outcome).toBeUndefined();
    const audits = parseAuditEvents(harness.logs.info);
    const last = audits.at(-1);
    expect(last?.decision).toBe("allow");
    expect(last?.toolName).toBe("web_fetch");
    expect(last?.riskTier).toBe("medium");
  });

  it("requires approval for high-risk tool calls and emits require_approval audit event", async () => {
    const harness = createHarness({
      policy: {
        allow: ["shell.exec"],
      },
      riskTiers: {
        high: {
          requireApproval: true,
        },
      },
    });

    const outcome = await harness.invoke({
      toolName: "exec",
      toolParams: { command: "echo hello" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(outcome?.block).toBe(true);
    expect(outcome?.blockReason).toContain("approval required");
    const audits = parseAuditEvents(harness.logs.info);
    const last = audits.at(-1);
    expect(last?.decision).toBe("require_approval");
    expect(last?.riskTier).toBe("high");
    expect(harness.enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("enforces configured rate limits", async () => {
    const harness = createHarness({
      policy: {
        allow: ["network.fetch"],
        allowDomains: ["example.com"],
      },
      rateLimit: {
        enabled: true,
        maxCalls: 1,
        windowMs: 60_000,
        scope: "session",
      },
    });

    const first = await harness.invoke({
      toolName: "web_fetch",
      toolParams: { url: "https://example.com/one" },
      ctx: { agentId: "main", sessionKey: "main" },
    });
    const second = await harness.invoke({
      toolName: "web_fetch",
      toolParams: { url: "https://example.com/two" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(first).toBeUndefined();
    expect(second?.block).toBe(true);
    expect(second?.blockReason).toContain("rate limit exceeded");
    const audits = parseAuditEvents(harness.logs.info);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const last = audits.at(-1);
    expect(last?.decision).toBe("deny");
    expect(last?.payload?.stage).toBe("rate_limit");
  });

  it("applies tool-specific policy overrides", async () => {
    const harness = createHarness({
      policy: {
        allow: ["network.fetch"],
        allowDomains: ["example.com"],
      },
      toolPolicies: {
        web_fetch: {
          allowDomains: ["allowed.example.org"],
        },
      },
    });

    const blocked = await harness.invoke({
      toolName: "web_fetch",
      toolParams: { url: "https://example.com/only-global" },
      ctx: { agentId: "main", sessionKey: "main" },
    });
    const allowed = await harness.invoke({
      toolName: "web_fetch",
      toolParams: { url: "https://allowed.example.org/ok" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(blocked?.block).toBe(true);
    expect(allowed).toBeUndefined();
    const audits = parseAuditEvents(harness.logs.info);
    expect(
      audits.some((entry) => entry.decision === "deny" && entry.toolName === "web_fetch"),
    ).toBe(true);
    expect(
      audits.some((entry) => entry.decision === "allow" && entry.toolName === "web_fetch"),
    ).toBe(true);
  });
});
