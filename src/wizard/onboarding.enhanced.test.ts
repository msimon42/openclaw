import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";
import { runEnhancedOnboardingWizard } from "./onboarding.enhanced.js";

const mocks = vi.hoisted(() => ({
  applyEnhancedModelStackConfig: vi.fn((params) => params.cfg),
  validateEnhancedModelStackAuth: vi.fn(() => ({ issues: [], warnings: [] })),
  applyEnhancedSkillsBundleConfig: vi.fn((params) => params.cfg),
  applyEnhancedMultiAgentConfig: vi.fn((params) => params.cfg),
  initializeEnhancedAgentTemplates: vi.fn(() => ({ warnings: [] })),
  applyEnhancedObservabilityConfig: vi.fn((params) => params.cfg),
  validateEnhancedObservabilityConfig: vi.fn(() => []),
  ensureEnhancedObservabilityDirs: vi.fn(async () => {}),
  runEnhancedFinalVerification: vi.fn(async () => ({
    ok: true,
    issues: [],
    warnings: [],
    testEventId: "obs-test-1",
    agents: ["main"],
    providers: ["xai"],
    models: ["xai/grok-3-fast-latest"],
  })),
  buildConfigChangePlan: vi.fn(() => []),
  applyOnboardingLocalWorkspaceConfig: vi.fn((cfg) => cfg),
  applyWizardMetadata: vi.fn((cfg) => cfg),
  ensureWorkspaceAndSessions: vi.fn(async () => {}),
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  writeConfigFile: vi.fn(async () => {}),
  resolveGatewayPort: vi.fn(() => 18789),
  logConfigUpdated: vi.fn(() => {}),
  buildWorkspaceSkillStatus: vi.fn(() => ({ skills: [] })),
  auditWorkspaceSkills: vi.fn(async () => ({
    timestamp: "now",
    workspaceDir: "/tmp/ws",
    totalSkills: 0,
    scannedFiles: 0,
    critical: 0,
    warn: 0,
    info: 0,
    skills: [],
  })),
  installSkill: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../commands/onboard-enhanced-profile.js", () => ({
  applyEnhancedModelStackConfig: mocks.applyEnhancedModelStackConfig,
  validateEnhancedModelStackAuth: mocks.validateEnhancedModelStackAuth,
  applyEnhancedSkillsBundleConfig: mocks.applyEnhancedSkillsBundleConfig,
  applyEnhancedMultiAgentConfig: mocks.applyEnhancedMultiAgentConfig,
  initializeEnhancedAgentTemplates: mocks.initializeEnhancedAgentTemplates,
  applyEnhancedObservabilityConfig: mocks.applyEnhancedObservabilityConfig,
  validateEnhancedObservabilityConfig: mocks.validateEnhancedObservabilityConfig,
  ensureEnhancedObservabilityDirs: mocks.ensureEnhancedObservabilityDirs,
  runEnhancedFinalVerification: mocks.runEnhancedFinalVerification,
  buildConfigChangePlan: mocks.buildConfigChangePlan,
  ENHANCED_DEFAULT_PROVIDERS: ["openai-codex", "ollama", "xai", "openrouter"],
  ENHANCED_MODEL_REFS: [
    "openai-codex/gpt-5.3-codex",
    "ollama/kimi-k2.5:cloud",
    "ollama/deepseek-v3.2:cloud",
    "xai/grok-3-fast-latest",
    "openrouter/free",
  ],
  ENHANCED_OBSERVABILITY_DEFAULTS: {
    enabled: true,
  },
  ENHANCED_ROUTING_PROFILE_ID: "enhancedDefault",
  ENHANCED_SKILL_BUNDLES: {
    enhancedCore: ["coding-agent"],
  },
  resolveEnhancedBundleSkillIds: vi.fn(() => ["coding-agent"]),
}));

vi.mock("../commands/onboard-config.js", () => ({
  applyOnboardingLocalWorkspaceConfig: mocks.applyOnboardingLocalWorkspaceConfig,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/ws",
  applyWizardMetadata: mocks.applyWizardMetadata,
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
  resolveControlUiLinks: mocks.resolveControlUiLinks,
}));

vi.mock("../config/config.js", () => ({
  writeConfigFile: mocks.writeConfigFile,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));

vi.mock("../agents/skills/audit.js", () => ({
  auditWorkspaceSkills: mocks.auditWorkspaceSkills,
}));

vi.mock("../agents/skills-install.js", () => ({
  installSkill: mocks.installSkill,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createPrompter(overrides?: Partial<WizardPrompter>): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => "modify") as WizardPrompter["select"],
    multiselect: vi.fn(async () => ["enhancedCore"]) as WizardPrompter["multiselect"],
    text: vi.fn(async () => "") as WizardPrompter["text"],
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}

describe("runEnhancedOnboardingWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs enhanced steps in order and writes config", async () => {
    const runtime = createRuntime();
    const prompter = createPrompter();

    await runEnhancedOnboardingWizard({
      opts: { nonInteractive: true, profile: "enhanced" },
      runtime,
      prompter,
      baseConfig: {},
    });

    expect(mocks.applyEnhancedModelStackConfig).toHaveBeenCalledTimes(1);
    expect(mocks.applyEnhancedSkillsBundleConfig).toHaveBeenCalledTimes(1);
    expect(mocks.applyEnhancedMultiAgentConfig).toHaveBeenCalledTimes(1);
    expect(mocks.applyEnhancedObservabilityConfig).toHaveBeenCalledTimes(1);
    expect(mocks.runEnhancedFinalVerification).toHaveBeenCalledTimes(1);
    expect(mocks.applyWizardMetadata).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profile: "enhanced" }),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
  });

  it("supports keep behavior without reapplying step config", async () => {
    const runtime = createRuntime();
    const prompter = createPrompter({
      select: vi.fn(async () => "keep") as WizardPrompter["select"],
    });
    const existingConfig = {
      models: { routingProfiles: { enhancedDefault: {} } },
      skills: { bundles: { enhancedCore: ["coding-agent"] } },
      agents: { list: [{ id: "main" }, { id: "admin" }] },
      observability: { enabled: true },
    };

    await runEnhancedOnboardingWizard({
      opts: { profile: "enhanced" },
      runtime,
      prompter,
      baseConfig: existingConfig,
    });

    expect(mocks.applyEnhancedModelStackConfig).not.toHaveBeenCalled();
    expect(mocks.applyEnhancedSkillsBundleConfig).not.toHaveBeenCalled();
    expect(mocks.applyEnhancedMultiAgentConfig).not.toHaveBeenCalled();
    expect(mocks.applyEnhancedObservabilityConfig).not.toHaveBeenCalled();
    expect(mocks.runEnhancedFinalVerification).toHaveBeenCalledTimes(1);
  });

  it("passes reset=true when reset is selected", async () => {
    const runtime = createRuntime();
    const prompter = createPrompter({
      select: vi.fn(async (params) => {
        if (params.message === "Model stack handling") {
          return "reset";
        }
        return "keep";
      }) as WizardPrompter["select"],
      confirm: vi.fn(async () => true),
    });

    const existingConfig = {
      models: { routingProfiles: { enhancedDefault: {} } },
      skills: { bundles: { enhancedCore: ["coding-agent"] } },
      agents: { list: [{ id: "main" }, { id: "admin" }] },
      observability: { enabled: true },
    };

    await runEnhancedOnboardingWizard({
      opts: { profile: "enhanced", forceReset: false },
      runtime,
      prompter,
      baseConfig: existingConfig,
    });

    expect(mocks.applyEnhancedModelStackConfig).toHaveBeenCalledWith(
      expect.objectContaining({ reset: true }),
    );
  });
});
