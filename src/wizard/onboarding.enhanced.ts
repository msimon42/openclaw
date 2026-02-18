import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";
import { installSkill } from "../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { auditWorkspaceSkills } from "../agents/skills/audit.js";
import { formatCliCommand } from "../cli/command-format.js";
import { applyOnboardingLocalWorkspaceConfig } from "../commands/onboard-config.js";
import {
  applyEnhancedModelStackConfig,
  applyEnhancedMultiAgentConfig,
  applyEnhancedObservabilityConfig,
  applyEnhancedSkillsBundleConfig,
  buildConfigChangePlan,
  ENHANCED_DEFAULT_PROVIDERS,
  ENHANCED_MODEL_REFS,
  ENHANCED_OBSERVABILITY_DEFAULTS,
  ENHANCED_ROUTING_PROFILE_ID,
  ENHANCED_SKILL_BUNDLES,
  ensureEnhancedObservabilityDirs,
  initializeEnhancedAgentTemplates,
  resolveEnhancedBundleSkillIds,
  runEnhancedFinalVerification,
  validateEnhancedModelStackAuth,
  validateEnhancedObservabilityConfig,
  type ConfigChange,
  type EnhancedBundleId,
  type EnhancedProviderId,
} from "../commands/onboard-enhanced-profile.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  resolveControlUiLinks,
} from "../commands/onboard-helpers.js";
import { resolveGatewayPort, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { resolveUserPath } from "../utils.js";

export type EnhancedOnboardingResult = {
  config: OpenClawConfig;
  workspaceDir: string;
};

type EnhancedOnboardingParams = {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  baseConfig: OpenClawConfig;
};

type StepAction = "keep" | "modify" | "reset";

function hasModelStackConfig(cfg: OpenClawConfig): boolean {
  if (cfg.models?.routingProfiles?.[ENHANCED_ROUTING_PROFILE_ID]) {
    return true;
  }
  if (cfg.agents?.defaults?.modelRouter?.enabled) {
    return true;
  }
  return ENHANCED_MODEL_REFS.some((modelRef) => Boolean(cfg.agents?.defaults?.models?.[modelRef]));
}

function hasSkillsBundleConfig(cfg: OpenClawConfig): boolean {
  return Boolean(cfg.skills?.bundles?.enhancedCore) || Boolean(cfg.skills?.entries);
}

function hasMultiAgentConfig(cfg: OpenClawConfig): boolean {
  const ids = new Set((cfg.agents?.list ?? []).map((entry) => entry.id));
  return ids.has("admin") || ids.has("worker") || ids.has("social") || ids.has("research");
}

function hasObservabilityConfig(cfg: OpenClawConfig): boolean {
  return cfg.observability?.enabled === true || cfg.observability?.stream?.enabled === true;
}

function formatPlan(plan: ConfigChange[]): string {
  if (plan.length === 0) {
    return "No config changes.";
  }
  const lines = ["Planned config changes:"];
  for (const change of plan) {
    const marker = change.kind === "add" ? "+" : change.kind === "remove" ? "-" : "~";
    lines.push(`${marker} ${change.path}`);
  }
  return lines.join("\n");
}

function disableSkills(cfg: OpenClawConfig, skillIds: string[]): OpenClawConfig {
  const entries = { ...cfg.skills?.entries };
  for (const skillId of skillIds) {
    entries[skillId] = {
      ...entries[skillId],
      enabled: false,
    };
  }
  return {
    ...cfg,
    skills: {
      ...cfg.skills,
      entries,
    },
  };
}

async function resolveStepAction(params: {
  id: string;
  label: string;
  hasExisting: boolean;
  opts: OnboardOptions;
  prompter: WizardPrompter;
}): Promise<StepAction> {
  if (!params.hasExisting) {
    return "modify";
  }
  if (params.opts.nonInteractive) {
    return params.opts.forceReset ? "reset" : "modify";
  }

  const action = (await params.prompter.select({
    message: `${params.label} handling`,
    options: [
      { value: "keep", label: "Keep existing", hint: `${params.id}: skip changes` },
      { value: "modify", label: "Modify", hint: `${params.id}: merge/update` },
      { value: "reset", label: "Reset", hint: `${params.id}: replace with enhanced defaults` },
    ],
    initialValue: "modify",
  })) as StepAction;

  if (action !== "reset") {
    return action;
  }
  if (params.opts.forceReset) {
    return "reset";
  }
  const confirmed = await params.prompter.confirm({
    message: `Confirm reset for ${params.label}? This may overwrite existing values.`,
    initialValue: false,
  });
  return confirmed ? "reset" : "modify";
}

async function confirmApply(params: {
  action: StepAction;
  opts: OnboardOptions;
  prompter: WizardPrompter;
  label: string;
}): Promise<boolean> {
  if (params.opts.nonInteractive) {
    return true;
  }
  return await params.prompter.confirm({
    message: `Apply ${params.label} ${params.action === "reset" ? "reset" : "changes"}?`,
    initialValue: true,
  });
}

async function maybeInstallBundleDependencies(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  selectedSkillIds: string[];
  opts: OnboardOptions;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}) {
  const report = buildWorkspaceSkillStatus(params.workspaceDir, { config: params.cfg });
  const selected = new Set(params.selectedSkillIds);
  const targets = report.skills.filter((skill) => {
    if (!selected.has(skill.skillKey) && !selected.has(skill.name)) {
      return false;
    }
    return skill.missing.bins.length > 0 && skill.install.length > 0;
  });

  if (targets.length === 0) {
    return;
  }

  if (!params.opts.nonInteractive) {
    const installNow = await params.prompter.confirm({
      message: `Install missing dependencies for ${targets.length} selected skills now?`,
      initialValue: true,
    });
    if (!installNow) {
      return;
    }
  }

  for (const skill of targets) {
    const installId = skill.install[0]?.id;
    if (!installId) {
      continue;
    }
    const progress = params.prompter.progress(`Installing ${skill.name}...`);
    const result = await installSkill({
      workspaceDir: params.workspaceDir,
      skillName: skill.name,
      installId,
      config: params.cfg,
    });
    if (result.ok) {
      progress.stop(`Installed ${skill.name}`);
      continue;
    }
    progress.stop(`Install failed for ${skill.name}`);
    params.runtime.error(
      [
        `Skill install failed: ${skill.name}`,
        result.message,
        `Try manually: ${formatCliCommand(`openclaw skills install ${skill.name}`)}`,
      ].join("\n"),
    );
  }
}

function resolveWorkspaceDir(opts: OnboardOptions, baseConfig: OpenClawConfig): string {
  const input = opts.workspace ?? baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;
  return resolveUserPath(input.trim() || DEFAULT_WORKSPACE);
}

async function runModelStackStep(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const action = await resolveStepAction({
    id: "modelStack",
    label: "Model stack",
    hasExisting: hasModelStackConfig(params.nextConfig),
    opts: params.opts,
    prompter: params.prompter,
  });

  if (action === "keep") {
    await params.prompter.note("modelStack: keeping existing config.", "modelStack");
    return params.nextConfig;
  }

  let providers = [...ENHANCED_DEFAULT_PROVIDERS] as EnhancedProviderId[];
  let includeOpenrouterFallback = true;
  if (!params.opts.nonInteractive) {
    providers = await params.prompter.multiselect<EnhancedProviderId>({
      message: "modelStack: select providers",
      options: [
        { value: "openai-codex", label: "OpenAI Codex" },
        { value: "ollama", label: "Ollama Cloud" },
        { value: "xai", label: "xAI" },
        { value: "openrouter", label: "OpenRouter free fallback" },
      ],
      initialValues: providers,
    });
    if (!providers.includes("openrouter")) {
      includeOpenrouterFallback = false;
    }
  }

  let candidate = applyEnhancedModelStackConfig({
    cfg: params.nextConfig,
    providers,
    includeOpenrouterFallback,
    reset: action === "reset",
  });

  const authValidation = validateEnhancedModelStackAuth({
    cfg: candidate,
    providers,
    includeOpenrouterFallback,
  });

  if (authValidation.issues.length > 0) {
    const issueText = authValidation.issues
      .map((issue) => `- ${issue.path}: ${issue.message}`)
      .join("\n");
    if (params.opts.nonInteractive && !params.opts.skipAuthCheck) {
      throw new Error(`modelStack auth preflight failed:\n${issueText}`);
    }

    await params.prompter.note(
      [
        "modelStack auth issues:",
        issueText,
        "You can continue with reduced capability (problem providers removed).",
      ].join("\n"),
      "modelStack",
    );

    if (!params.opts.nonInteractive) {
      const continueReduced = await params.prompter.confirm({
        message: "Continue with reduced capability?",
        initialValue: true,
      });
      if (!continueReduced) {
        throw new Error("modelStack cancelled due to missing provider auth");
      }
    }

    const reducedProviders = providers.filter((provider) => {
      if (provider === "openrouter") {
        return includeOpenrouterFallback;
      }
      if (provider === "openai-codex") {
        return !authValidation.issues.some((issue) => issue.path === "auth.profiles");
      }
      return !authValidation.issues.some((issue) =>
        issue.path.startsWith(`models.providers.${provider}`),
      );
    });

    candidate = applyEnhancedModelStackConfig({
      cfg: params.nextConfig,
      providers: reducedProviders,
      includeOpenrouterFallback: reducedProviders.includes("openrouter"),
      reset: action === "reset",
    });
  }

  if (authValidation.warnings.length > 0) {
    await params.prompter.note(
      authValidation.warnings.map((warning) => `- ${warning.path}: ${warning.message}`).join("\n"),
      "modelStack warnings",
    );
  }

  const plan = buildConfigChangePlan({
    before: params.nextConfig,
    after: candidate,
    roots: [
      "models.routingProfiles",
      "agents.defaults.modelRouter",
      "agents.defaults.models",
      "models.providers",
    ],
  });
  await params.prompter.note(formatPlan(plan), "modelStack plan");

  const shouldApply = await confirmApply({
    action,
    opts: params.opts,
    prompter: params.prompter,
    label: "modelStack",
  });
  if (!shouldApply) {
    return params.nextConfig;
  }

  return candidate;
}

async function runSkillsBundleStep(params: {
  nextConfig: OpenClawConfig;
  workspaceDir: string;
  opts: OnboardOptions;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<OpenClawConfig> {
  const action = await resolveStepAction({
    id: "skillsBundle",
    label: "Skills bundle",
    hasExisting: hasSkillsBundleConfig(params.nextConfig),
    opts: params.opts,
    prompter: params.prompter,
  });

  if (action === "keep") {
    await params.prompter.note("skillsBundle: keeping existing config.", "skillsBundle");
    return params.nextConfig;
  }

  let bundles = ["enhancedCore"] as string[];
  if (!params.opts.nonInteractive) {
    bundles = await params.prompter.multiselect<string>({
      message: "skillsBundle: select bundles",
      options: [
        {
          value: "enhancedCore",
          label: "enhanced-core",
          hint: "Core skills bundle (required)",
        },
        {
          value: "socialOps",
          label: "social-ops",
          hint: "Messaging and social channel helpers",
        },
        {
          value: "productivity",
          label: "productivity",
          hint: "Task and knowledge base helpers",
        },
      ],
      initialValues: ["enhancedCore"],
    });
  }

  if (!bundles.includes("enhancedCore")) {
    bundles.unshift("enhancedCore");
  }

  const selectedSkillIds = resolveEnhancedBundleSkillIds(bundles);
  let candidate = applyEnhancedSkillsBundleConfig({
    cfg: params.nextConfig,
    bundleIds: bundles,
    reset: action === "reset",
  });

  const plan = buildConfigChangePlan({
    before: params.nextConfig,
    after: candidate,
    roots: ["skills.bundles", "skills.entries"],
  });
  await params.prompter.note(formatPlan(plan), "skillsBundle plan");

  const shouldApply = await confirmApply({
    action,
    opts: params.opts,
    prompter: params.prompter,
    label: "skillsBundle",
  });
  if (!shouldApply) {
    return params.nextConfig;
  }

  await maybeInstallBundleDependencies({
    cfg: candidate,
    workspaceDir: params.workspaceDir,
    selectedSkillIds,
    opts: params.opts,
    prompter: params.prompter,
    runtime: params.runtime,
  });

  const audit = await auditWorkspaceSkills({
    workspaceDir: params.workspaceDir,
    config: candidate,
  });
  if (audit.critical > 0 || audit.warn > 0) {
    await params.prompter.note(
      [
        `skillsBundle audit: critical=${audit.critical} warn=${audit.warn} info=${audit.info}`,
        "Enabled state will be blocked until audit issues are resolved.",
      ].join("\n"),
      "skillsBundle audit",
    );

    if (!params.opts.nonInteractive) {
      const proceedWithoutEnable = await params.prompter.confirm({
        message: "Proceed without enabling selected skills?",
        initialValue: true,
      });
      if (!proceedWithoutEnable) {
        throw new Error("skillsBundle blocked by audit findings");
      }
    }
    candidate = disableSkills(candidate, selectedSkillIds);
  }

  return candidate;
}

async function runMultiAgentStep(params: {
  nextConfig: OpenClawConfig;
  workspaceDir: string;
  opts: OnboardOptions;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const action = await resolveStepAction({
    id: "multiAgent",
    label: "Multi-agent",
    hasExisting: hasMultiAgentConfig(params.nextConfig),
    opts: params.opts,
    prompter: params.prompter,
  });

  if (action === "keep") {
    await params.prompter.note("multiAgent: keeping existing config.", "multiAgent");
    return params.nextConfig;
  }

  const candidate = applyEnhancedMultiAgentConfig({
    cfg: params.nextConfig,
    workspaceDir: params.workspaceDir,
    reset: action === "reset",
  });

  const init = initializeEnhancedAgentTemplates({
    cfg: candidate,
    force: action === "reset" && params.opts.forceReset === true,
  });
  if (init.warnings.length > 0) {
    await params.prompter.note(init.warnings.join("\n"), "multiAgent template init");
  }

  const plan = buildConfigChangePlan({
    before: params.nextConfig,
    after: candidate,
    roots: ["agents.defaults.multiAgent", "agents.list", "bindings", "session.dmScope"],
  });
  await params.prompter.note(formatPlan(plan), "multiAgent plan");

  const shouldApply = await confirmApply({
    action,
    opts: params.opts,
    prompter: params.prompter,
    label: "multiAgent",
  });
  if (!shouldApply) {
    return params.nextConfig;
  }

  return candidate;
}

async function runObservabilityStep(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const action = await resolveStepAction({
    id: "observability",
    label: "Observability",
    hasExisting: hasObservabilityConfig(params.nextConfig),
    opts: params.opts,
    prompter: params.prompter,
  });

  if (action === "keep") {
    await params.prompter.note("observability: keeping existing config.", "observability");
    return params.nextConfig;
  }

  const candidate = applyEnhancedObservabilityConfig({
    cfg: params.nextConfig,
    reset: action === "reset",
  });

  const obsIssues = validateEnhancedObservabilityConfig(candidate);
  if (obsIssues.length > 0) {
    throw new Error(obsIssues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  }

  const plan = buildConfigChangePlan({
    before: params.nextConfig,
    after: candidate,
    roots: ["observability"],
  });
  await params.prompter.note(formatPlan(plan), "observability plan");

  const shouldApply = await confirmApply({
    action,
    opts: params.opts,
    prompter: params.prompter,
    label: "observability",
  });
  if (!shouldApply) {
    return params.nextConfig;
  }

  await ensureEnhancedObservabilityDirs(candidate);
  return candidate;
}

function renderFinalCommands(config: OpenClawConfig): string[] {
  const port = resolveGatewayPort(config);
  const links = resolveControlUiLinks({
    bind: config.gateway?.bind ?? "loopback",
    port,
    customBindHost: config.gateway?.customBindHost,
    basePath: config.gateway?.controlUi?.basePath,
  });

  return [
    formatCliCommand("openclaw agents list"),
    formatCliCommand("openclaw models list"),
    formatCliCommand("openclaw health --probe"),
    formatCliCommand("openclaw status --all"),
    `${formatCliCommand("openclaw dashboard --no-open")} (${links.httpUrl})`,
  ];
}

export async function runEnhancedOnboardingWizard(
  params: EnhancedOnboardingParams,
): Promise<EnhancedOnboardingResult> {
  const workspaceDir = resolveWorkspaceDir(params.opts, params.baseConfig);

  let nextConfig = applyOnboardingLocalWorkspaceConfig(params.baseConfig, workspaceDir);

  await params.prompter.note(
    [
      "Profile: enhanced",
      "Steps:",
      "- modelStack",
      "- skillsBundle",
      "- multiAgent",
      "- observability",
      "- finalVerification",
    ].join("\n"),
    "Setup profile",
  );

  nextConfig = await runModelStackStep({
    nextConfig,
    opts: params.opts,
    prompter: params.prompter,
  });

  nextConfig = await runSkillsBundleStep({
    nextConfig,
    workspaceDir,
    opts: params.opts,
    prompter: params.prompter,
    runtime: params.runtime,
  });

  nextConfig = await runMultiAgentStep({
    nextConfig,
    workspaceDir,
    opts: params.opts,
    prompter: params.prompter,
  });

  nextConfig = await runObservabilityStep({
    nextConfig,
    opts: params.opts,
    prompter: params.prompter,
  });

  const verification = await runEnhancedFinalVerification(nextConfig);
  if (!verification.ok) {
    const lines = verification.issues.map((issue) => `- ${issue.path}: ${issue.message}`);
    throw new Error(["finalVerification failed:", ...lines].join("\n"));
  }

  if (verification.warnings.length > 0) {
    await params.prompter.note(
      verification.warnings.map((warning) => `- ${warning.path}: ${warning.message}`).join("\n"),
      "finalVerification warnings",
    );
  }

  const nextCommands = renderFinalCommands(nextConfig);
  await params.prompter.note(
    [
      `Agents: ${verification.agents.join(", ")}`,
      `Providers: ${verification.providers.join(", ")}`,
      `Models allowlist: ${verification.models.length}`,
      verification.testEventId
        ? `Observability test event: ${verification.testEventId}`
        : undefined,
      "",
      "Next commands:",
      ...nextCommands.map((command) => `- ${command}`),
    ]
      .filter(Boolean)
      .join("\n"),
    "finalVerification",
  );

  nextConfig = applyWizardMetadata(nextConfig, {
    command: "onboard",
    mode: "local",
    profile: "enhanced",
  });
  await writeConfigFile(nextConfig);
  logConfigUpdated(params.runtime);

  await ensureWorkspaceAndSessions(workspaceDir, params.runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  return {
    config: nextConfig,
    workspaceDir,
  };
}

export const ENHANCED_ONBOARDING_DEFAULTS = {
  providers: [...ENHANCED_DEFAULT_PROVIDERS],
  bundles: Object.keys(ENHANCED_SKILL_BUNDLES) as EnhancedBundleId[],
  observability: ENHANCED_OBSERVABILITY_DEFAULTS,
} as const;
