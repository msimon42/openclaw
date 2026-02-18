import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfigReturn: {
    agents: {
      list: [{ id: "main" }, { id: "worker" }, { id: "research" }],
      defaults: {
        multiAgent: {
          delegation: {
            timeoutMs: 120_000,
            maxDepth: 3,
            maxCallsPerTrace: 8,
            maxToolCalls: 24,
            dedupeWindowMs: 60_000,
            pairRateLimitPerMinute: 6,
          },
        },
      },
    },
  } as Record<string, unknown>,
  updateSessionStore: vi.fn(async (_path, updater) => {
    const store: Record<string, unknown> = {};
    await updater(store);
  }),
  resolveGatewaySessionStoreTarget: vi.fn(() => ({
    storePath: "/tmp/sessions.json",
    canonicalKey: "agent:worker:inbox",
  })),
  loadSessionEntry: vi.fn(() => ({
    entry: { sessionId: "sess-worker" },
    storePath: "/tmp/sessions.json",
    canonicalKey: "agent:worker:workflow:trace",
  })),
  readSessionMessages: vi.fn(() => [{ role: "assistant", content: "worker summary output" }]),
  chatInject: vi.fn(({ respond }) => respond(true, { ok: true, messageId: "msg-1" })),
  agent: vi.fn(({ respond }) => respond(true, { runId: "run-1" })),
  waitForAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  maybeAutoPublishLongPayload: vi.fn(
    (params: { message: string; artifactRefs?: Array<{ artifactId: string; kind: string }> }) => ({
      message: params.message,
      artifactRefs: params.artifactRefs ?? [],
    }),
  ),
  publishArtifact: vi.fn(() => ({
    artifactId: "art_summary",
    metadata: { kind: "application/json" },
    payloadPath: "/tmp/art_summary.json",
    metaPath: "/tmp/art_summary.meta.json",
  })),
  fetchArtifact: vi.fn(),
  writeHandoffBrief: vi.fn(() => "/tmp/brief.json"),
  observeAgentMessage: vi.fn(),
  observeAgentCallStart: vi.fn(),
  observeAgentCallEnd: vi.fn(),
  observeAgentCallError: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => mocks.loadConfigReturn,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main", "worker", "research"],
  resolveAgentDir: () => "/tmp/agent-dir",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../session-utils.js", () => ({
  resolveGatewaySessionStoreTarget: mocks.resolveGatewaySessionStoreTarget,
  loadSessionEntry: mocks.loadSessionEntry,
  readSessionMessages: mocks.readSessionMessages,
  listAgentsForGateway: () => ({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "global",
    agents: [{ id: "main" }, { id: "worker" }, { id: "research" }],
  }),
}));

vi.mock("../../agents/artifacts.js", () => ({
  maybeAutoPublishLongPayload: mocks.maybeAutoPublishLongPayload,
  publishArtifact: mocks.publishArtifact,
  fetchArtifact: mocks.fetchArtifact,
  writeHandoffBrief: mocks.writeHandoffBrief,
}));

vi.mock("../../infra/observability.js", () => ({
  observeAgentMessage: mocks.observeAgentMessage,
  observeAgentCallStart: mocks.observeAgentCallStart,
  observeAgentCallEnd: mocks.observeAgentCallEnd,
  observeAgentCallError: mocks.observeAgentCallError,
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.inject": (...args: unknown[]) =>
      (mocks.chatInject as (...inner: unknown[]) => unknown)(...args),
    "chat.abort": ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) =>
      respond(true, { ok: true, aborted: false, runIds: [] }),
  },
}));

vi.mock("./agent.js", () => ({
  agentHandlers: {
    agent: (...args: unknown[]) => (mocks.agent as (...inner: unknown[]) => unknown)(...args),
  },
}));

vi.mock("./agent-job.js", () => ({
  waitForAgentJob: (...args: unknown[]) =>
    (mocks.waitForAgentJob as (...inner: unknown[]) => unknown)(...args),
}));

const { agentsHandlers } = await import("./agents.js");

type HandlerParams = Parameters<(typeof agentsHandlers)["agents.call"]>[0];

function makeReq(method: keyof typeof agentsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  const context = {
    dedupe: new Map(),
    addChatRun: vi.fn(),
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatAbortedRuns: new Map(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    registerToolEventRecipient: vi.fn(),
    unregisterToolEventRecipient: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as HandlerParams["context"];
  const promise = agentsHandlers[method]({
    params,
    respond,
    context,
    req: { type: "req", id: "test-req", method },
    client: null,
    isWebchatConnect: () => false,
  });
  return { respond, promise };
}

function getOkPayload(respond: ReturnType<typeof vi.fn>) {
  const first = respond.mock.calls[0] as [boolean, unknown, unknown] | undefined;
  expect(first?.[0]).toBe(true);
  return first?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agent.mockImplementation(({ respond }) => respond(true, { runId: "run-1" }));
  mocks.waitForAgentJob.mockResolvedValue({ status: "ok" });
  mocks.readSessionMessages.mockReturnValue([{ role: "assistant", content: "worker summary output" }]);
});

describe("agents.message", () => {
  it("injects an inbox message without triggering agent execution", async () => {
    const { respond, promise } = makeReq("agents.message", {
      fromAgentId: "main",
      toAgentId: "worker",
      traceId: "trace-message-1",
      message: "please pick this up async",
    });
    await promise;

    expect(mocks.chatInject).toHaveBeenCalledTimes(1);
    expect(mocks.agent).not.toHaveBeenCalled();
    const payload = getOkPayload(respond);
    expect(payload.sessionKey).toBe("agent:worker:inbox");
  });
});

describe("agents.call", () => {
  it("runs delegated call and returns summary + artifact refs", async () => {
    const { respond, promise } = makeReq("agents.call", {
      fromAgentId: "main",
      toAgentId: "worker",
      traceId: "trace-call-ok",
      message: "do work",
    });
    await promise;

    expect(mocks.agent).toHaveBeenCalledTimes(1);
    expect(mocks.waitForAgentJob).toHaveBeenCalledTimes(1);
    const payload = getOkPayload(respond);
    expect(payload.status).toBe("ok");
    const summary = typeof payload.summary === "string" ? payload.summary : "";
    expect(summary).toContain("worker summary output");
    expect(Array.isArray(payload.artifacts)).toBe(true);
    expect((payload.artifacts as Array<{ artifactId?: string }>).some((entry) => entry.artifactId === "art_summary")).toBe(true);
  });

  it("returns timeout status when delegated run does not complete in time", async () => {
    mocks.waitForAgentJob.mockResolvedValueOnce(null as never);
    const { respond, promise } = makeReq("agents.call", {
      fromAgentId: "main",
      toAgentId: "worker",
      traceId: "trace-call-timeout",
      message: "do long work",
      limits: { timeoutMs: 100 },
    });
    await promise;

    const payload = getOkPayload(respond);
    expect(payload.status).toBe("timeout");
  });

  it("blocks recursive delegation when maxDepth is reached", async () => {
    let releaseAgent: (() => void) | null = null;
    mocks.agent.mockImplementation(
      ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) =>
        new Promise<void>((resolve) => {
          releaseAgent = () => {
            respond(true, { runId: "run-depth" });
            resolve();
          };
        }),
    );
    mocks.waitForAgentJob.mockResolvedValue({ status: "ok" });

    const first = makeReq("agents.call", {
      fromAgentId: "main",
      toAgentId: "worker",
      traceId: "trace-depth-1",
      message: "outer call",
      limits: { maxDepth: 1, timeoutMs: 60_000 },
    });
    await Promise.resolve();

    const second = makeReq("agents.call", {
      fromAgentId: "main",
      toAgentId: "worker",
      traceId: "trace-depth-1",
      message: "inner call",
      limits: { maxDepth: 1, timeoutMs: 60_000 },
    });
    await second.promise;
    const blockedPayload = getOkPayload(second.respond);
    expect(blockedPayload.status).toBe("blocked");

    const release = releaseAgent as (() => void) | null;
    if (release) {
      release();
    }
    await first.promise;
  });

  it("dedupes repeated identical delegated calls within the dedupe window", async () => {
    const first = makeReq("agents.call", {
      fromAgentId: "main",
      toAgentId: "worker",
      traceId: "trace-dedupe-1",
      message: "repeatable task",
      sessionKey: "agent:worker:workflow:trace-dedupe-1",
    });
    await first.promise;

    const second = makeReq("agents.call", {
      fromAgentId: "main",
      toAgentId: "worker",
      traceId: "trace-dedupe-1",
      message: "repeatable task",
      sessionKey: "agent:worker:workflow:trace-dedupe-1",
    });
    await second.promise;

    const secondPayload = getOkPayload(second.respond);
    expect(secondPayload.status).toBe("deduped");
  });
});
