import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyEnhancedModelStackConfig,
  applyEnhancedMultiAgentConfig,
  applyEnhancedSkillsBundleConfig,
  ENHANCED_MODEL_REFS,
  runEnhancedFinalVerification,
  validateEnhancedModelStackAuth,
  validateEnhancedObservabilityConfig,
} from "./onboard-enhanced-profile.js";

describe("onboard enhanced profile helpers", () => {
  let tempRoot = "";

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-enhanced-test-"));
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies model stack idempotently and keeps required allowlist refs", () => {
    const once = applyEnhancedModelStackConfig({ cfg: {} });
    const twice = applyEnhancedModelStackConfig({ cfg: once });

    expect(twice.agents?.defaults?.modelRouter?.enabled).toBe(true);
    for (const modelRef of ENHANCED_MODEL_REFS) {
      expect(twice.agents?.defaults?.models?.[modelRef]).toBeTruthy();
    }
    expect(twice.agents?.defaults?.models).toEqual(once.agents?.defaults?.models);
  });

  it("applies multi-agent defaults idempotently without duplicate ids", () => {
    const workspace = path.join(tempRoot, "ws-idempotent");
    const once = applyEnhancedMultiAgentConfig({ cfg: {}, workspaceDir: workspace });
    const twice = applyEnhancedMultiAgentConfig({ cfg: once, workspaceDir: workspace });

    const ids = (twice.agents?.list ?? []).map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    const bindings = twice.bindings ?? [];
    const keys = bindings.map((binding) =>
      [
        binding.agentId,
        binding.match.channel,
        binding.match.accountId ?? "",
        binding.match.peer?.kind ?? "",
        binding.match.peer?.id ?? "",
      ].join("|"),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("applies skills bundle idempotently", () => {
    const once = applyEnhancedSkillsBundleConfig({
      cfg: {},
      bundleIds: ["enhancedCore"],
    });
    const twice = applyEnhancedSkillsBundleConfig({
      cfg: once,
      bundleIds: ["enhancedCore"],
    });

    expect(twice.skills?.bundles?.enhancedCore).toEqual(once.skills?.bundles?.enhancedCore);
    expect(twice.skills?.entries).toEqual(once.skills?.entries);
  });

  it("reports missing provider auth for required enhanced providers", async () => {
    const isolatedAgentDir = path.join(tempRoot, "agent-no-auth");
    await fs.mkdir(isolatedAgentDir, { recursive: true });

    const prev = {
      openrouter: process.env.OPENROUTER_API_KEY,
      xai: process.env.XAI_API_KEY,
      ollama: process.env.OLLAMA_API_KEY,
      openclawAgentDir: process.env.OPENCLAW_AGENT_DIR,
    };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    process.env.OPENCLAW_AGENT_DIR = isolatedAgentDir;

    try {
      const cfg = applyEnhancedModelStackConfig({ cfg: {} });
      const validation = validateEnhancedModelStackAuth({ cfg, agentDir: isolatedAgentDir });
      expect(validation.issues.some((issue) => issue.path === "auth.profiles")).toBe(true);
      expect(
        validation.issues.some((issue) => issue.path.startsWith("models.providers.ollama")),
      ).toBe(true);
      expect(validation.issues.some((issue) => issue.path.startsWith("models.providers.xai"))).toBe(
        true,
      );
      expect(
        validation.warnings.some((warning) =>
          warning.path.startsWith("models.providers.openrouter"),
        ),
      ).toBe(true);
    } finally {
      process.env.OPENROUTER_API_KEY = prev.openrouter;
      process.env.XAI_API_KEY = prev.xai;
      process.env.OLLAMA_API_KEY = prev.ollama;
      process.env.OPENCLAW_AGENT_DIR = prev.openclawAgentDir;
    }
  });

  it("rejects invalid observability streaming bounds", () => {
    const cfg = {
      observability: {
        stream: {
          replayWindowMs: 100,
          serverMaxEventsPerSec: 0,
          serverMaxBufferedEvents: 10,
          messageMaxBytes: 100,
        },
      },
    };

    const issues = validateEnhancedObservabilityConfig(cfg);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.path === "observability.stream.replayWindowMs")).toBe(true);
    expect(issues.some((issue) => issue.path === "observability.stream.messageMaxBytes")).toBe(
      true,
    );
  });

  it("verifies a valid enhanced config", async () => {
    const workspace = path.join(tempRoot, "ws-verify");
    const modelCfg = applyEnhancedModelStackConfig({ cfg: {} });
    const skillsCfg = applyEnhancedSkillsBundleConfig({
      cfg: modelCfg,
      bundleIds: ["enhancedCore"],
    });
    const agentsCfg = applyEnhancedMultiAgentConfig({ cfg: skillsCfg, workspaceDir: workspace });
    const cfg = applyEnhancedObservabilityConfigForTest(agentsCfg);

    const result = await runEnhancedFinalVerification(cfg);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.agents.includes("main")).toBe(true);
  });
});

function applyEnhancedObservabilityConfigForTest<T extends object>(cfg: T) {
  return {
    ...cfg,
    observability: {
      enabled: true,
      stream: {
        enabled: false,
        replayWindowMs: 300_000,
        serverMaxEventsPerSec: 50,
        serverMaxBufferedEvents: 10_000,
        messageMaxBytes: 65_536,
      },
      audit: {
        enabled: true,
      },
      spend: {
        enabled: true,
      },
      health: {
        enabled: true,
      },
    },
  };
}
