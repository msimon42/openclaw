import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  emitAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "./agent-events.js";
import {
  flushObservability,
  getObservabilityPaths,
  observeToolCallBlocked,
  resetObservabilityForTests,
} from "./observability.js";

vi.mock("../agents/pi-embedded-helpers.js", () => ({
  isLikelyContextOverflowError: (message?: string) =>
    typeof message === "string" && /context length exceeded/i.test(message),
  classifyFailoverReason: () => null,
}));

const { runWithModelFallback } = await import("../agents/model-fallback.js");

const createdDirs: string[] = [];

function utcDay(timestamp: number): string {
  const date = new Date(timestamp);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function makeConfig(baseDir: string): OpenClawConfig {
  return {
    observability: {
      enabled: true,
      redactionMode: "strict",
      audit: {
        enabled: true,
        dir: path.join(baseDir, "audit"),
      },
      spend: {
        enabled: true,
        dir: path.join(baseDir, "spend"),
      },
      health: {
        enabled: true,
        failureThreshold: 2,
        windowMs: 60_000,
        openMs: 60_000,
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["anthropic/claude-haiku-3-5"],
        },
      },
    },
  } as OpenClawConfig;
}

async function readAuditEvents(cfg: OpenClawConfig): Promise<Array<Record<string, unknown>>> {
  const { auditDir } = getObservabilityPaths(cfg);
  const file = path.join(auditDir, `${utcDay(Date.now())}.jsonl`);
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("observability integration", () => {
  beforeEach(() => {
    resetObservabilityForTests();
    resetAgentRunContextForTest();
  });

  afterEach(async () => {
    resetObservabilityForTests();
    resetAgentRunContextForTest();
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("records model fallback events and request summary", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obs-int-"));
    createdDirs.push(tmpDir);
    const cfg = makeConfig(tmpDir);
    const runId = "obs-run-fallback";
    registerAgentRunContext(runId, {
      sessionKey: "agent:main:discord:dm:1",
      config: cfg,
    });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: Date.now(), agentId: "main" },
      sessionKey: "agent:main:discord:dm:1",
    });

    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("provider unavailable"), { status: 503 }))
      .mockResolvedValueOnce({
        ok: true,
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      requestId: runId,
      agentId: "main",
      run,
    });

    expect(result.provider).toBe("anthropic");

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: Date.now(), agentId: "main" },
      sessionKey: "agent:main:discord:dm:1",
    });

    await flushObservability(cfg);
    const events = await readAuditEvents(cfg);
    const eventTypes = events.map((event) => String(event.eventType));

    expect(eventTypes).toContain("model.call.error");
    expect(eventTypes).toContain("model.fallback");
    expect(eventTypes).toContain("model.call.end");

    const requestEnd = events.find((event) => event.eventType === "request.end");
    expect(requestEnd).toBeTruthy();
    const metrics = (requestEnd?.metrics ?? {}) as Record<string, unknown>;
    expect(metrics.fallbackHops).toBe(1);
  });

  it("records blocked tool attempts and request summary", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obs-tool-"));
    createdDirs.push(tmpDir);
    const cfg = makeConfig(tmpDir);
    const runId = "obs-run-blocked-tool";
    registerAgentRunContext(runId, {
      sessionKey: "agent:main:discord:dm:1",
      config: cfg,
    });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: Date.now(), agentId: "main" },
      sessionKey: "agent:main:discord:dm:1",
    });

    observeToolCallBlocked(
      {
        runId,
        toolName: "bash",
        toolCallId: "call-1",
        reason: "blocked in test",
        agentId: "main",
        sessionKey: "agent:main:discord:dm:1",
      },
      cfg,
    );

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: Date.now(), agentId: "main" },
      sessionKey: "agent:main:discord:dm:1",
    });

    await flushObservability(cfg);
    const events = await readAuditEvents(cfg);
    const eventTypes = events.map((event) => String(event.eventType));

    expect(eventTypes).toContain("tool.call.start");
    expect(eventTypes).toContain("tool.call.blocked");

    const requestEnd = events.find((event) => event.eventType === "request.end");
    const metrics = (requestEnd?.metrics ?? {}) as Record<string, unknown>;
    expect(Number(metrics.blockedToolCalls ?? 0)).toBeGreaterThanOrEqual(1);
  });
});
