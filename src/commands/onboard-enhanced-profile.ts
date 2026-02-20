import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentBinding } from "../config/types.js";
import type {
  ConfigValidationIssue,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.js";
import { initAgentWorkspace } from "../agents/agent-init.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { PHASE5_DEFAULT_ROUTES, validateModelRouterAllowlist } from "../agents/model-router.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import { emitObservabilityTestEvent } from "../infra/observability.js";
import { applyAgentBindings } from "./agents.bindings.js";
import { applyAgentConfig, listAgentEntries } from "./agents.config.js";
import { ensureModelAllowlistEntry } from "./model-allowlist.js";
import { applyOpenrouterProviderConfig, applyXaiProviderConfig } from "./onboard-auth.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "./openai-codex-model-default.js";

export const ENHANCED_ONBOARD_PROFILE = "enhanced" as const;
export const ENHANCED_ROUTING_PROFILE_ID = "enhancedDefault";

export const ENHANCED_MODEL_REFS = [
  "openai-codex/gpt-5.3-codex",
  "ollama/kimi-k2.5:cloud",
  "ollama/deepseek-v3.2:cloud",
  "xai/grok-3-fast-latest",
  "openrouter/free",
] as const;

export type EnhancedProviderId = "openai-codex" | "ollama" | "xai" | "openrouter";

export const ENHANCED_DEFAULT_PROVIDERS: readonly EnhancedProviderId[] = [
  "openai-codex",
  "ollama",
  "xai",
  "openrouter",
] as const;

export const ENHANCED_SKILL_BUNDLES = {
  enhancedCore: ["coding-agent", "github", "session-logs", "healthcheck", "tmux"],
  socialOps: ["discord", "slack", "voice-call"],
  productivity: ["notion", "trello", "obsidian"],
} as const;

export type EnhancedBundleId = keyof typeof ENHANCED_SKILL_BUNDLES;

export const ENHANCED_AGENT_IDS = ["main", "admin", "worker", "social", "research"] as const;

export type ConfigChangeKind = "add" | "update" | "remove";

export type ConfigChange = {
  path: string;
  kind: ConfigChangeKind;
  before?: unknown;
  after?: unknown;
};

export type EnhancedAuthValidation = {
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
};

export type EnhancedVerification = {
  ok: boolean;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  testEventId?: string;
  agents: string[];
  providers: string[];
  models: string[];
};

const ENHANCED_OLLAMA_BASE_URL = "https://api.ollama.ai/v1";
const ENHANCED_XAI_BASE_URL = "https://api.x.ai/v1";

export const ENHANCED_OBSERVABILITY_DEFAULTS = {
  enabled: true,
  debug: false,
  redactionMode: "strict" as const,
  audit: {
    enabled: true,
    dir: "./openclaw-data/audit",
    maxPayloadBytes: 262_144,
    maxQueueSize: 10_000,
  },
  spend: {
    enabled: true,
    dir: "./openclaw-data/spend",
    summaryPath: "./openclaw-data/spend/summary.json",
  },
  health: {
    enabled: true,
    failureThreshold: 3,
    windowMs: 60_000,
    openMs: 60_000,
    emitIntervalMs: 30_000,
  },
  stream: {
    enabled: true,
    replayWindowMs: 300_000,
    serverMaxEventsPerSec: 50,
    serverMaxBufferedEvents: 10_000,
    messageMaxBytes: 65_536,
  },
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getValueAtPath(value: unknown, pathStr: string): unknown {
  if (!pathStr) {
    return value;
  }
  const segments = pathStr.split(".").filter(Boolean);
  let cursor: unknown = value;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function setValueAtPath(target: Record<string, unknown>, pathStr: string, next: unknown) {
  const segments = pathStr.split(".").filter(Boolean);
  const lastKey = segments.at(-1);
  if (!lastKey) {
    return;
  }
  let cursor: Record<string, unknown> = target;
  for (const key of segments.slice(0, -1)) {
    const current = cursor[key];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[lastKey] = next;
}

function collectLeafValues(value: unknown, prefix: string, map: Map<string, unknown>) {
  if (Array.isArray(value)) {
    map.set(prefix, value);
    return;
  }
  if (!value || typeof value !== "object") {
    map.set(prefix, value);
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    map.set(prefix, value);
    return;
  }
  for (const [key, child] of entries.toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    collectLeafValues(child, nextPrefix, map);
  }
}

export function buildConfigChangePlan(params: {
  before: OpenClawConfig;
  after: OpenClawConfig;
  roots: string[];
  maxEntries?: number;
}): ConfigChange[] {
  const beforeMap = new Map<string, unknown>();
  const afterMap = new Map<string, unknown>();
  for (const root of params.roots) {
    collectLeafValues(getValueAtPath(params.before, root), root, beforeMap);
    collectLeafValues(getValueAtPath(params.after, root), root, afterMap);
  }

  const keys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const changes: ConfigChange[] = [];
  for (const key of [...keys].toSorted()) {
    const before = beforeMap.get(key);
    const after = afterMap.get(key);
    const hasBefore = beforeMap.has(key);
    const hasAfter = afterMap.has(key);
    if (!hasBefore && hasAfter) {
      changes.push({ path: key, kind: "add", after });
      continue;
    }
    if (hasBefore && !hasAfter) {
      changes.push({ path: key, kind: "remove", before });
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ path: key, kind: "update", before, after });
    }
  }

  const maxEntries = params.maxEntries ?? 24;
  return changes.slice(0, maxEntries);
}

function ensureModelAllowlistEntries(cfg: OpenClawConfig, refs: readonly string[]): OpenClawConfig {
  let next = cfg;
  for (const modelRef of refs) {
    next = ensureModelAllowlistEntry({ cfg: next, modelRef });
  }
  return next;
}

function ensureOllamaCloudProvider(cfg: OpenClawConfig): OpenClawConfig {
  const providers = { ...cfg.models?.providers };
  const current = providers.ollama as ModelProviderConfig | undefined;

  const baseUrlRaw = current?.baseUrl?.trim() || ENHANCED_OLLAMA_BASE_URL;
  const baseUrl = baseUrlRaw.endsWith("/v1") ? baseUrlRaw : `${baseUrlRaw.replace(/\/+$/, "")}/v1`;
  const existingModels: ModelDefinitionConfig[] = Array.isArray(current?.models)
    ? current.models
    : [];

  const knownIds = new Set(
    existingModels
      .map((model) => model.id?.trim())
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const cloudModels = [
    {
      id: "kimi-k2.5:cloud",
      name: "Kimi K2.5 (Cloud)",
      reasoning: true,
      input: ["text"] as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    {
      id: "deepseek-v3.2:cloud",
      name: "DeepSeek V3.2 (Cloud)",
      reasoning: true,
      input: ["text"] as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  ];
  const mergedModels = [...existingModels];
  for (const model of cloudModels) {
    if (!knownIds.has(model.id)) {
      mergedModels.push(model);
      knownIds.add(model.id);
    }
  }

  providers.ollama = {
    baseUrl,
    api: current?.api ?? "openai-completions",
    ...(current?.apiKey ? { apiKey: current.apiKey } : {}),
    ...(current?.auth ? { auth: current.auth } : {}),
    models: mergedModels,
  };

  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers,
    },
  };
}

function buildEnhancedRouterConfig(includeOpenrouterFallback: boolean) {
  const routes = deepClone(PHASE5_DEFAULT_ROUTES);
  if (!includeOpenrouterFallback) {
    for (const key of Object.keys(routes) as Array<keyof typeof routes>) {
      routes[key].fallbacks = routes[key].fallbacks.filter((ref) => ref !== "openrouter/free");
    }
  }
  return {
    defaultRoute: "everyday" as const,
    routes,
  };
}

function normalizeProviderList(providers?: EnhancedProviderId[]): EnhancedProviderId[] {
  const input = providers && providers.length > 0 ? providers : [...ENHANCED_DEFAULT_PROVIDERS];
  const unique = new Set<EnhancedProviderId>();
  for (const provider of input) {
    unique.add(provider);
  }
  return [...unique];
}

function hasProviderAuth(params: {
  cfg: OpenClawConfig;
  provider: EnhancedProviderId;
  agentDir?: string;
}): boolean {
  if (params.provider === "openai-codex") {
    try {
      const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
      return listProfilesForProvider(store, "openai-codex").length > 0;
    } catch {
      return false;
    }
  }

  const envProvider = params.provider === "openrouter" ? "openrouter" : params.provider;
  if (resolveEnvApiKey(envProvider)?.apiKey) {
    return true;
  }
  if (getCustomProviderApiKey(params.cfg, envProvider)) {
    return true;
  }
  try {
    const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
    return listProfilesForProvider(store, envProvider).length > 0;
  } catch {
    return false;
  }
}

export function validateEnhancedModelStackAuth(params: {
  cfg: OpenClawConfig;
  providers?: EnhancedProviderId[];
  includeOpenrouterFallback?: boolean;
  agentDir?: string;
}): EnhancedAuthValidation {
  const selectedProviders = normalizeProviderList(params.providers);
  const includeOpenrouterFallback = params.includeOpenrouterFallback !== false;
  const issues: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [];

  for (const provider of selectedProviders) {
    if (provider === "openrouter" && !includeOpenrouterFallback) {
      continue;
    }
    if (hasProviderAuth({ cfg: params.cfg, provider, agentDir: params.agentDir })) {
      continue;
    }
    if (provider === "openrouter") {
      warnings.push({
        path: "models.providers.openrouter",
        message:
          "openrouter fallback selected but OPENROUTER_API_KEY/auth profile is missing. Set OPENROUTER_API_KEY or skip free fallback.",
      });
      continue;
    }
    if (provider === "openai-codex") {
      issues.push({
        path: "auth.profiles",
        message:
          "openai-codex selected but no OpenAI Codex auth profile is configured. Run: openclaw auth login openai-codex",
      });
      continue;
    }
    if (provider === "ollama") {
      issues.push({
        path: "models.providers.ollama",
        message:
          "ollama cloud selected but no OLLAMA_API_KEY/auth profile is configured. Set OLLAMA_API_KEY and ensure models.providers.ollama.baseUrl includes /v1.",
      });
      continue;
    }
    if (provider === "xai") {
      issues.push({
        path: "models.providers.xai",
        message:
          "xai selected but no XAI_API_KEY/auth profile is configured. Set XAI_API_KEY or run: openclaw onboard --auth-choice xai-api-key",
      });
      continue;
    }
  }

  const ollamaBaseUrl = params.cfg.models?.providers?.ollama?.baseUrl?.trim();
  if (selectedProviders.includes("ollama") && ollamaBaseUrl && !ollamaBaseUrl.endsWith("/v1")) {
    issues.push({
      path: "models.providers.ollama.baseUrl",
      message: "ollama cloud baseUrl must include /v1.",
    });
  }

  const xaiBaseUrl = params.cfg.models?.providers?.xai?.baseUrl?.trim();
  if (selectedProviders.includes("xai") && xaiBaseUrl && xaiBaseUrl !== ENHANCED_XAI_BASE_URL) {
    issues.push({
      path: "models.providers.xai.baseUrl",
      message: `xai baseUrl must be ${ENHANCED_XAI_BASE_URL}.`,
    });
  }

  const allowlistValidation = validateModelRouterAllowlist({ cfg: params.cfg });
  issues.push(...allowlistValidation.issues);
  warnings.push(...allowlistValidation.warnings);

  return { issues, warnings };
}

export function applyEnhancedModelStackConfig(params: {
  cfg: OpenClawConfig;
  providers?: EnhancedProviderId[];
  includeOpenrouterFallback?: boolean;
  reset?: boolean;
}): OpenClawConfig {
  const selectedProviders = normalizeProviderList(params.providers);
  const includeOpenrouterFallback = params.includeOpenrouterFallback !== false;

  let next = params.cfg;
  if (params.reset) {
    const providers = { ...next.models?.providers };
    delete providers.ollama;
    delete providers.xai;
    delete providers.openrouter;
    next = {
      ...next,
      models: {
        ...next.models,
        providers,
      },
    };
  }

  if (selectedProviders.includes("openai-codex")) {
    next = applyOpenAICodexModelDefault(next).next;
  }
  if (selectedProviders.includes("ollama")) {
    next = ensureOllamaCloudProvider(next);
  }
  if (selectedProviders.includes("xai")) {
    next = applyXaiProviderConfig(next);
    const currentXaiProvider = next.models?.providers?.xai;
    next = {
      ...next,
      models: {
        ...next.models,
        providers: {
          ...next.models?.providers,
          xai: {
            ...currentXaiProvider,
            baseUrl: ENHANCED_XAI_BASE_URL,
            models: currentXaiProvider?.models ?? [],
          },
        },
      },
    };
  }
  if (selectedProviders.includes("openrouter") && includeOpenrouterFallback) {
    next = applyOpenrouterProviderConfig(next);
  }

  const profileConfig = buildEnhancedRouterConfig(includeOpenrouterFallback);
  const routingProfiles = {
    ...next.models?.routingProfiles,
    [ENHANCED_ROUTING_PROFILE_ID]: profileConfig,
  };

  next = {
    ...next,
    models: {
      ...next.models,
      routingProfiles,
    },
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          primary: OPENAI_CODEX_DEFAULT_MODEL,
          fallbacks: [
            "ollama/deepseek-v3.2:cloud",
            "ollama/kimi-k2.5:cloud",
            ...(includeOpenrouterFallback ? ["openrouter/free"] : []),
          ],
        },
        modelRouter: {
          enabled: true,
          defaultRoute: "everyday",
          routes: profileConfig.routes,
        },
      },
    },
  };

  const requiredRefs = includeOpenrouterFallback
    ? [...ENHANCED_MODEL_REFS]
    : ENHANCED_MODEL_REFS.filter((ref) => ref !== "openrouter/free");
  return ensureModelAllowlistEntries(next, requiredRefs);
}

export function resolveEnhancedBundleSkillIds(bundleIds: string[]): string[] {
  const ids = new Set<string>();
  for (const bundleId of bundleIds) {
    const bundle = ENHANCED_SKILL_BUNDLES[bundleId as EnhancedBundleId];
    if (!bundle) {
      continue;
    }
    for (const skillId of bundle) {
      ids.add(skillId);
    }
  }
  return [...ids];
}

export function applyEnhancedSkillsBundleConfig(params: {
  cfg: OpenClawConfig;
  bundleIds: string[];
  enableSkillIds?: string[];
  reset?: boolean;
}): OpenClawConfig {
  const selectedBundleIds = [...new Set(params.bundleIds.map((id) => id.trim()).filter(Boolean))];
  const selectedSkills =
    params.enableSkillIds && params.enableSkillIds.length > 0
      ? [...new Set(params.enableSkillIds.map((id) => id.trim()).filter(Boolean))]
      : resolveEnhancedBundleSkillIds(selectedBundleIds);

  const entries = { ...params.cfg.skills?.entries };

  if (params.reset) {
    const knownBundleSkills = new Set(
      resolveEnhancedBundleSkillIds(Object.keys(ENHANCED_SKILL_BUNDLES)),
    );
    for (const skillId of knownBundleSkills) {
      if (!entries[skillId]) {
        continue;
      }
      entries[skillId] = {
        ...entries[skillId],
        enabled: false,
      };
    }
  }

  for (const skillId of selectedSkills) {
    entries[skillId] = {
      ...entries[skillId],
      enabled: true,
    };
  }

  return {
    ...params.cfg,
    skills: {
      ...params.cfg.skills,
      bundles: {
        ...params.cfg.skills?.bundles,
        enhancedCore: resolveEnhancedBundleSkillIds(["enhancedCore"]),
        ...(selectedBundleIds.includes("socialOps")
          ? { socialOps: resolveEnhancedBundleSkillIds(["socialOps"]) }
          : {}),
        ...(selectedBundleIds.includes("productivity")
          ? { productivity: resolveEnhancedBundleSkillIds(["productivity"]) }
          : {}),
      },
      entries,
    },
  };
}

function resolveMultiAgentWorkspaceRoot(workspaceDir: string): string {
  return path.resolve(workspaceDir, "workspaces");
}

function resolveTemplateWorkspace(workspaceRoot: string, agentId: string): string {
  return path.join(workspaceRoot, "agents", agentId);
}

function ensureDefaultBindings(cfg: OpenClawConfig): OpenClawConfig {
  const desiredBindings: AgentBinding[] = [{ agentId: "main", match: { channel: "webchat" } }];

  if (cfg.channels?.telegram) {
    desiredBindings.push({ agentId: "social", match: { channel: "telegram" } });
  }
  if (cfg.channels?.discord) {
    desiredBindings.push({ agentId: "worker", match: { channel: "discord" } });
  }
  if (cfg.channels?.slack) {
    desiredBindings.push({ agentId: "research", match: { channel: "slack" } });
  }

  return applyAgentBindings(cfg, desiredBindings).config;
}

export function applyEnhancedMultiAgentConfig(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  reset?: boolean;
}): OpenClawConfig {
  const workspaceRoot = resolveMultiAgentWorkspaceRoot(params.workspaceDir);
  const existingById = new Map(listAgentEntries(params.cfg).map((entry) => [entry.id, entry]));

  let next = params.cfg;
  if (params.reset) {
    const cleaned = listAgentEntries(next).filter((entry) => {
      if (entry.id === "main") {
        return true;
      }
      return !ENHANCED_AGENT_IDS.includes(entry.id as (typeof ENHANCED_AGENT_IDS)[number]);
    });
    next = {
      ...next,
      agents: {
        ...next.agents,
        list: cleaned,
      },
    };
  }

  const names: Record<string, string> = {
    main: "Main",
    admin: "Admin",
    worker: "Worker",
    social: "Social",
    research: "Research",
  };

  for (const agentId of ENHANCED_AGENT_IDS) {
    const existing = existingById.get(agentId);
    const workspace =
      existing?.workspace?.trim() || resolveTemplateWorkspace(workspaceRoot, agentId);
    const agentDir = existing?.agentDir?.trim() || resolveAgentDir(next, agentId);
    next = applyAgentConfig(next, {
      agentId,
      name: names[agentId],
      workspace,
      agentDir,
    });
  }

  next = {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        multiAgent: {
          ...next.agents?.defaults?.multiAgent,
          workspaceRoot,
          artifactAutoPublishChars:
            next.agents?.defaults?.multiAgent?.artifactAutoPublishChars ?? 2_000,
          delegation: {
            timeoutMs: next.agents?.defaults?.multiAgent?.delegation?.timeoutMs ?? 120_000,
            maxDepth: next.agents?.defaults?.multiAgent?.delegation?.maxDepth ?? 3,
            maxCallsPerTrace: next.agents?.defaults?.multiAgent?.delegation?.maxCallsPerTrace ?? 8,
            maxToolCalls: next.agents?.defaults?.multiAgent?.delegation?.maxToolCalls ?? 24,
            dedupeWindowMs: next.agents?.defaults?.multiAgent?.delegation?.dedupeWindowMs ?? 60_000,
            pairRateLimitPerMinute:
              next.agents?.defaults?.multiAgent?.delegation?.pairRateLimitPerMinute ?? 6,
          },
        },
      },
    },
    session: {
      ...next.session,
      dmScope: next.session?.dmScope ?? "per-account-channel-peer",
    },
  };

  return ensureDefaultBindings(next);
}

export function initializeEnhancedAgentTemplates(params: {
  cfg: OpenClawConfig;
  force?: boolean;
}): { warnings: string[] } {
  const warnings: string[] = [];
  for (const agentId of ["admin", "worker", "social", "research"] as const) {
    try {
      initAgentWorkspace({
        cfg: params.cfg,
        agentId,
        template: agentId,
        force: params.force,
      });
    } catch (err) {
      warnings.push(`template init skipped for ${agentId}: ${String(err)}`);
    }
  }
  return { warnings };
}

export function validateEnhancedObservabilityConfig(cfg: OpenClawConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const stream = cfg.observability?.stream;
  if (!stream) {
    return issues;
  }
  const replay = stream.replayWindowMs;
  if (typeof replay === "number" && (replay < 10_000 || replay > 3_600_000)) {
    issues.push({
      path: "observability.stream.replayWindowMs",
      message: "must be between 10000 and 3600000",
    });
  }
  const perSec = stream.serverMaxEventsPerSec;
  if (typeof perSec === "number" && (perSec < 1 || perSec > 1_000)) {
    issues.push({
      path: "observability.stream.serverMaxEventsPerSec",
      message: "must be between 1 and 1000",
    });
  }
  const buffered = stream.serverMaxBufferedEvents;
  if (typeof buffered === "number" && (buffered < 100 || buffered > 100_000)) {
    issues.push({
      path: "observability.stream.serverMaxBufferedEvents",
      message: "must be between 100 and 100000",
    });
  }
  const maxBytes = stream.messageMaxBytes;
  if (typeof maxBytes === "number" && (maxBytes < 1024 || maxBytes > 1_048_576)) {
    issues.push({
      path: "observability.stream.messageMaxBytes",
      message: "must be between 1024 and 1048576",
    });
  }
  return issues;
}

export function applyEnhancedObservabilityConfig(params: {
  cfg: OpenClawConfig;
  reset?: boolean;
}): OpenClawConfig {
  if (params.reset) {
    return {
      ...params.cfg,
      observability: deepClone(ENHANCED_OBSERVABILITY_DEFAULTS),
    };
  }

  return {
    ...params.cfg,
    observability: {
      ...params.cfg.observability,
      enabled: true,
      debug: params.cfg.observability?.debug ?? ENHANCED_OBSERVABILITY_DEFAULTS.debug,
      redactionMode:
        params.cfg.observability?.redactionMode ?? ENHANCED_OBSERVABILITY_DEFAULTS.redactionMode,
      audit: {
        ...ENHANCED_OBSERVABILITY_DEFAULTS.audit,
        ...params.cfg.observability?.audit,
        enabled: params.cfg.observability?.audit?.enabled ?? true,
      },
      spend: {
        ...ENHANCED_OBSERVABILITY_DEFAULTS.spend,
        ...params.cfg.observability?.spend,
        enabled: params.cfg.observability?.spend?.enabled ?? true,
      },
      health: {
        ...ENHANCED_OBSERVABILITY_DEFAULTS.health,
        ...params.cfg.observability?.health,
        enabled: params.cfg.observability?.health?.enabled ?? true,
      },
      stream: {
        ...ENHANCED_OBSERVABILITY_DEFAULTS.stream,
        ...params.cfg.observability?.stream,
        enabled: params.cfg.observability?.stream?.enabled ?? true,
      },
    },
  };
}

export async function ensureEnhancedObservabilityDirs(cfg: OpenClawConfig): Promise<void> {
  const auditDir = cfg.observability?.audit?.dir?.trim();
  const spendDir = cfg.observability?.spend?.dir?.trim();
  if (auditDir) {
    await fs.mkdir(path.resolve(auditDir), { recursive: true });
  }
  if (spendDir) {
    await fs.mkdir(path.resolve(spendDir), { recursive: true });
  }
}

export async function runEnhancedFinalVerification(
  cfg: OpenClawConfig,
): Promise<EnhancedVerification> {
  const issues: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [];

  const validation = validateConfigObjectWithPlugins(cfg);
  if (!validation.ok) {
    issues.push(...validation.issues);
    warnings.push(...validation.warnings);
  } else {
    warnings.push(...validation.warnings);
  }

  const obsIssues = validateEnhancedObservabilityConfig(cfg);
  issues.push(...obsIssues);

  let testEventId: string | undefined;
  if (issues.length === 0 && cfg.observability?.enabled && cfg.observability?.stream?.enabled) {
    try {
      testEventId = await emitObservabilityTestEvent(cfg);
    } catch (err) {
      issues.push({
        path: "observability.stream",
        message: `failed to emit observability test event: ${String(err)}`,
      });
    }
  }

  const agents = listAgentEntries(cfg).map((entry) => entry.id);
  const providers = Object.keys(cfg.models?.providers ?? {}).toSorted();
  const models = Object.keys(cfg.agents?.defaults?.models ?? {}).toSorted();

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    testEventId,
    agents,
    providers,
    models,
  };
}

export function applyConfigPatchByPath<T extends OpenClawConfig>(
  cfg: T,
  patch: Record<string, unknown>,
): T {
  const next = deepClone(cfg) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    setValueAtPath(next, key, value);
  }
  return next as T;
}
