import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "./model-auth.js";
import {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  modelKey,
  normalizeModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
  type ModelRef,
} from "./model-selection.js";

const log = createSubsystemLogger("agents/model-router");

export type ModelRouteKind = "coding" | "everyday" | "x";

export type ModelRouteConfig = {
  primary: string;
  fallbacks: string[];
};

export type ModelRouterConfig = {
  enabled?: boolean;
  debug?: boolean;
  defaultRoute?: ModelRouteKind;
  disabledProviders?: string[];
  routes?: Partial<Record<ModelRouteKind, Partial<ModelRouteConfig>>>;
};

export type ModelRouterInput = {
  message: string;
  channel?: string;
  commandModelOverride?: string;
  hasUrls?: boolean;
  repoContext?: "unknown" | "coding" | "chat";
  toolRequirements?: {
    webSearch?: boolean;
    webFetch?: boolean;
  };
  requiredCapabilities?: string[];
  explicitTags?: string[];
};

export type ModelPlan = {
  route: ModelRouteKind;
  primary: ModelRef;
  fallbacks: ModelRef[];
  rationale: string[];
  tags: string[];
};

export type ResolvedModelRouterDecision = {
  provider: string;
  model: string;
  fallbacksOverride?: string[];
  plan?: ModelPlan;
  debugEnabled: boolean;
};

export type ModelRouterValidationIssue = {
  path: string;
  message: string;
};

export type ModelRouterValidationResult = {
  issues: ModelRouterValidationIssue[];
  warnings: ModelRouterValidationIssue[];
};

export class ModelRoutingConfigError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "ModelRoutingConfigError";
    this.path = path;
  }
}

export const PHASE5_DEFAULT_ROUTES: Record<ModelRouteKind, ModelRouteConfig> = {
  coding: {
    primary: "openai-codex/gpt-5.3-codex",
    fallbacks: ["ollama/deepseek-v3.2:cloud", "ollama/kimi-k2.5:cloud", "openrouter/free"],
  },
  everyday: {
    primary: "ollama/kimi-k2.5:cloud",
    fallbacks: ["ollama/deepseek-v3.2:cloud", "openrouter/free"],
  },
  x: {
    primary: "xai/grok-3-fast-latest",
    fallbacks: ["openai-codex/gpt-5.3-codex", "ollama/deepseek-v3.2:cloud", "openrouter/free"],
  },
};

const CODING_HINTS = [
  /\bimplement\b/i,
  /\brefactor\b/i,
  /\bfix(?:ing)?\s+(?:build|tests?|ci)\b/i,
  /\btests?\s+failing\b/i,
  /\bpull request\b/i,
  /\bpr\b/i,
  /\bdiff\b/i,
  /\btypescript\b/i,
  /\bnode(?:\.js)?\b/i,
  /\bopenclaw\b/i,
  /\brepo(?:sitory)?\b/i,
  /\bci\b/i,
];

const X_HINTS = [
  /\bx\/twitter\b/i,
  /\btwitter\b/i,
  /\bx\.com\b/i,
  /\btweet(?:s)?\b/i,
  /\bthread(?:s)?\b/i,
  /\bviral posts?\b/i,
  /\bwhat(?:'| i)s happening on x\b/i,
  /@[a-z0-9_]{2,}/i,
];

const GROK_ALIAS_MODELS = new Set<string>([
  "grok-3",
  "grok-3-fast",
  "grok-3-fast-latest",
  "grok-3-latest",
]);

const MODEL_ROUTER_DEBUG_ENV = "OPENCLAW_MODEL_ROUTER_DEBUG";
const MODEL_ROUTER_ENABLED_ENV = "OPENCLAW_MODEL_ROUTER";
const MODEL_CAPABILITIES = new Map<string, Set<string>>([
  [
    "openai-codex/gpt-5.3-codex",
    new Set(["coding", "tools", "reasoning", "repo", "general", "long-context"]),
  ],
  ["ollama/kimi-k2.5:cloud", new Set(["general", "tools", "long-context"])],
  ["ollama/deepseek-v3.2:cloud", new Set(["general", "tools", "coding", "long-context"])],
  ["xai/grok-3-fast-latest", new Set(["general", "x", "social"])],
  ["openrouter/free", new Set(["general"])],
]);

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveModelRouterConfig(cfg: OpenClawConfig): ModelRouterConfig | undefined {
  const raw = cfg.agents?.defaults?.modelRouter;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  return raw as ModelRouterConfig;
}

function normalizeGrokAlias(ref: ModelRef): ModelRef {
  if (ref.provider !== "xai") {
    return ref;
  }
  const normalizedModel = ref.model.trim().toLowerCase();
  if (!GROK_ALIAS_MODELS.has(normalizedModel)) {
    return ref;
  }
  return { provider: "xai", model: "grok-3-fast-latest" };
}

function toRawModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

function resolveRequiredCapabilities(input: ModelRouterInput): Set<string> {
  const required = new Set<string>();
  for (const capability of input.requiredCapabilities ?? []) {
    const normalized = capability.trim().toLowerCase();
    if (normalized) {
      required.add(normalized);
    }
  }
  if (input.toolRequirements?.webFetch || input.toolRequirements?.webSearch) {
    required.add("tools");
  }
  return required;
}

function supportsRequiredCapabilities(ref: ModelRef, required: Set<string>): boolean {
  if (required.size === 0) {
    return true;
  }
  const capabilities = MODEL_CAPABILITIES.get(toRawModelRef(ref));
  if (!capabilities || capabilities.size === 0) {
    // Unknown models are treated as permissive to avoid brittle rejects.
    return true;
  }
  for (const capability of required) {
    if (!capabilities.has(capability)) {
      return false;
    }
  }
  return true;
}

function normalizeDisabledProviders(cfg: ModelRouterConfig | undefined): Set<string> {
  const disabled = new Set<string>();
  for (const provider of cfg?.disabledProviders ?? []) {
    const normalized = provider.trim().toLowerCase();
    if (normalized) {
      disabled.add(normalized);
    }
  }
  return disabled;
}

function normalizeRouteConfig(
  route: ModelRouteConfig,
  defaultProvider: string,
  aliasIndex: ReturnType<typeof buildModelAliasIndex>,
): { primary: ModelRef; fallbacks: ModelRef[] } {
  const primaryResolved = resolveModelRefFromString({
    raw: route.primary,
    defaultProvider,
    aliasIndex,
  });
  const primary = normalizeGrokAlias(
    primaryResolved?.ref ?? normalizeModelRef(DEFAULT_PROVIDER, DEFAULT_MODEL),
  );

  const seen = new Set<string>([modelKey(primary.provider, primary.model)]);
  const fallbacks: ModelRef[] = [];
  for (const raw of route.fallbacks) {
    const resolved = resolveModelRefFromString({
      raw,
      defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    const normalized = normalizeGrokAlias(resolved.ref);
    const key = modelKey(normalized.provider, normalized.model);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    fallbacks.push(normalized);
  }
  return { primary, fallbacks };
}

function resolveRouteKind(
  input: ModelRouterInput,
  cfg: ModelRouterConfig | undefined,
): {
  route: ModelRouteKind;
  rationale: string[];
  tags: string[];
} {
  const rationale: string[] = [];
  const tags = new Set<string>(input.explicitTags ?? []);
  const text = input.message.trim();

  if (input.commandModelOverride?.trim()) {
    tags.add("model_override");
    rationale.push("explicit model override present");
    return {
      route: cfg?.defaultRoute ?? "everyday",
      rationale,
      tags: Array.from(tags),
    };
  }

  if (X_HINTS.some((pattern) => pattern.test(text))) {
    tags.add("route:x");
    tags.add("intent:x-twitter");
    rationale.push("matched X/Twitter heuristic");
    return { route: "x", rationale, tags: Array.from(tags) };
  }

  if (input.repoContext === "coding") {
    tags.add("repo:coding");
    rationale.push("repo context indicates coding task");
  }
  if (CODING_HINTS.some((pattern) => pattern.test(text))) {
    tags.add("route:coding");
    tags.add("intent:coding");
    rationale.push("matched coding/repo heuristic");
    return { route: "coding", rationale, tags: Array.from(tags) };
  }
  if (input.repoContext === "coding") {
    tags.add("route:coding");
    tags.add("intent:coding");
    return { route: "coding", rationale, tags: Array.from(tags) };
  }

  if (input.toolRequirements?.webFetch || input.toolRequirements?.webSearch) {
    tags.add("tools:web");
    rationale.push("web tooling requested; using everyday route");
  }
  if (input.hasUrls) {
    tags.add("message:has_urls");
  }
  if (input.channel?.trim()) {
    tags.add(`channel:${input.channel.trim().toLowerCase()}`);
  }
  tags.add("route:everyday");
  tags.add("intent:default");
  rationale.push("default route selected");
  return { route: "everyday", rationale, tags: Array.from(tags) };
}

function buildRouteConfig(params: {
  cfg: ModelRouterConfig | undefined;
  route: ModelRouteKind;
}): ModelRouteConfig {
  const base = PHASE5_DEFAULT_ROUTES[params.route];
  const override = params.cfg?.routes?.[params.route];
  if (!override) {
    return base;
  }
  return {
    primary: override.primary?.trim() || base.primary,
    fallbacks: Array.isArray(override.fallbacks) ? override.fallbacks : base.fallbacks,
  };
}

function isModelRouterEnabled(cfg: OpenClawConfig): boolean {
  if (isTruthyEnv(process.env[MODEL_ROUTER_ENABLED_ENV])) {
    return true;
  }
  const routerCfg = resolveModelRouterConfig(cfg);
  if (!routerCfg) {
    return false;
  }
  return routerCfg.enabled !== false;
}

function isModelRouterDebugEnabled(cfg: OpenClawConfig, forceDebug?: boolean): boolean {
  if (forceDebug) {
    return true;
  }
  if (isTruthyEnv(process.env[MODEL_ROUTER_DEBUG_ENV])) {
    return true;
  }
  return resolveModelRouterConfig(cfg)?.debug === true;
}

export function decideModelPlan(
  input: ModelRouterInput,
  options?: {
    defaultProvider?: string;
    routerConfig?: ModelRouterConfig;
    aliasIndex?: ReturnType<typeof buildModelAliasIndex>;
  },
): ModelPlan {
  const defaultProvider = options?.defaultProvider ?? DEFAULT_PROVIDER;
  const aliasIndex =
    options?.aliasIndex ??
    buildModelAliasIndex({
      cfg: {} as OpenClawConfig,
      defaultProvider,
    });
  const routeChoice = resolveRouteKind(input, options?.routerConfig);
  const routeConfig = buildRouteConfig({
    cfg: options?.routerConfig,
    route: routeChoice.route,
  });
  const normalized = normalizeRouteConfig(routeConfig, defaultProvider, aliasIndex);
  return {
    route: routeChoice.route,
    primary: normalized.primary,
    fallbacks: normalized.fallbacks,
    rationale: routeChoice.rationale,
    tags: routeChoice.tags,
  };
}

export function resolveModelRoutingDecision(params: {
  cfg: OpenClawConfig;
  input: ModelRouterInput;
  provider: string;
  model: string;
  fallbacksOverride?: string[];
  preserveNonDefaultSelection?: boolean;
  forceDebug?: boolean;
}): ResolvedModelRouterDecision {
  const debugEnabled = isModelRouterDebugEnabled(params.cfg, params.forceDebug);
  if (!isModelRouterEnabled(params.cfg)) {
    return {
      provider: params.provider,
      model: params.model,
      fallbacksOverride: params.fallbacksOverride,
      debugEnabled,
    };
  }

  const configuredDefault = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const normalizedCurrent = normalizeModelRef(params.provider, params.model);
  const normalizedDefault = normalizeModelRef(configuredDefault.provider, configuredDefault.model);
  const preserveCurrent =
    params.preserveNonDefaultSelection === true &&
    modelKey(normalizedCurrent.provider, normalizedCurrent.model) !==
      modelKey(normalizedDefault.provider, normalizedDefault.model);
  if (preserveCurrent) {
    return {
      provider: params.provider,
      model: params.model,
      fallbacksOverride: params.fallbacksOverride,
      debugEnabled,
    };
  }

  const routerCfg = resolveModelRouterConfig(params.cfg);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: normalizedDefault.provider,
  });
  const plan = decideModelPlan(params.input, {
    defaultProvider: normalizedDefault.provider,
    routerConfig: routerCfg,
    aliasIndex,
  });
  const disabledProviders = normalizeDisabledProviders(routerCfg);
  const requiredCapabilities = resolveRequiredCapabilities(params.input);
  const filteredRationale = [...plan.rationale];

  const filteredCandidates = [plan.primary, ...plan.fallbacks].filter((ref) => {
    const providerId = ref.provider.trim().toLowerCase();
    if (disabledProviders.has(providerId)) {
      filteredRationale.push(`skipped ${toRawModelRef(ref)}: provider disabled`);
      return false;
    }
    if (!supportsRequiredCapabilities(ref, requiredCapabilities)) {
      filteredRationale.push(`skipped ${toRawModelRef(ref)}: capability mismatch`);
      return false;
    }
    return true;
  });

  const fallbackPrimary = normalizeModelRef(params.provider, params.model);
  const primaryRef = filteredCandidates[0] ?? fallbackPrimary;
  const routeFallbacks = filteredCandidates.slice(1);

  const mergedFallbacks = new Set<string>();
  for (const ref of routeFallbacks) {
    mergedFallbacks.add(toRawModelRef(ref));
  }
  for (const raw of params.fallbacksOverride ?? []) {
    const resolved = resolveModelRefFromString({
      raw,
      defaultProvider: normalizedDefault.provider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    mergedFallbacks.add(toRawModelRef(normalizeGrokAlias(resolved.ref)));
  }

  const decision: ResolvedModelRouterDecision = {
    provider: primaryRef.provider,
    model: primaryRef.model,
    fallbacksOverride: Array.from(mergedFallbacks),
    plan: {
      ...plan,
      primary: primaryRef,
      fallbacks: routeFallbacks,
      rationale: filteredRationale,
    },
    debugEnabled,
  };
  if (debugEnabled) {
    const debugPlan = decision.plan;
    log.info(
      `[model-router:decision] ${JSON.stringify({
        route: debugPlan?.route ?? null,
        primary: `${decision.provider}/${decision.model}`,
        fallbacks: decision.fallbacksOverride,
        rationale: debugPlan?.rationale ?? [],
        tags: debugPlan?.tags ?? [],
      })}`,
    );
  }
  return decision;
}

export function validateModelRouterAllowlist(params: {
  cfg: OpenClawConfig;
  defaultProvider?: string;
}): ModelRouterValidationResult {
  if (!isModelRouterEnabled(params.cfg)) {
    return { issues: [], warnings: [] };
  }
  const configuredDefault = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const defaultProvider = params.defaultProvider ?? configuredDefault.provider;
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
  });
  if (!allowlist || allowlist.size === 0) {
    return {
      issues: [],
      warnings: [
        {
          path: "agents.defaults.models",
          message:
            "modelRouter is enabled without an explicit agents.defaults.models allowlist; add explicit model keys for safer routing.",
        },
      ],
    };
  }

  const routerCfg = resolveModelRouterConfig(params.cfg);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
  });
  const missing = new Set<string>();
  for (const route of ["coding", "everyday", "x"] as const) {
    const routeConfig = buildRouteConfig({ cfg: routerCfg, route });
    const normalized = normalizeRouteConfig(routeConfig, defaultProvider, aliasIndex);
    const refs = [normalized.primary, ...normalized.fallbacks];
    for (const ref of refs) {
      const key = modelKey(ref.provider, ref.model);
      if (!allowlist.has(key)) {
        missing.add(key);
      }
    }
  }

  if (missing.size === 0) {
    return { issues: [], warnings: [] };
  }
  return {
    issues: [
      {
        path: "agents.defaults.models",
        message: `modelRouter references models missing from allowlist: ${Array.from(missing).toSorted().join(", ")}`,
      },
    ],
    warnings: [],
  };
}

function hasProviderAuthConfigured(cfg: OpenClawConfig, provider: string): boolean {
  if (resolveEnvApiKey(provider)?.apiKey) {
    return true;
  }
  if (getCustomProviderApiKey(cfg, provider)) {
    return true;
  }
  try {
    const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
    return listProfilesForProvider(store, provider).length > 0;
  } catch {
    return false;
  }
}

export function validateModelRouterAuth(params: {
  cfg: OpenClawConfig;
  defaultProvider?: string;
}): ModelRouterValidationResult {
  if (!isModelRouterEnabled(params.cfg)) {
    return { issues: [], warnings: [] };
  }
  const configuredDefault = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const defaultProvider = params.defaultProvider ?? configuredDefault.provider;
  const routerCfg = resolveModelRouterConfig(params.cfg);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
  });
  const providers = new Set<string>();
  let includesOpenRouterFree = false;
  for (const route of ["coding", "everyday", "x"] as const) {
    const routeConfig = buildRouteConfig({ cfg: routerCfg, route });
    const normalized = normalizeRouteConfig(routeConfig, defaultProvider, aliasIndex);
    const refs = [normalized.primary, ...normalized.fallbacks];
    for (const ref of refs) {
      providers.add(ref.provider);
      if (ref.provider === "openrouter" && ref.model === "free") {
        includesOpenRouterFree = true;
      }
    }
  }

  const warnings: ModelRouterValidationIssue[] = [];
  for (const provider of providers) {
    if (hasProviderAuthConfigured(params.cfg, provider)) {
      continue;
    }
    warnings.push({
      path: `models.providers.${provider}`,
      message: `modelRouter references provider "${provider}" but no auth is configured (profile/env/config api key).`,
    });
  }

  if (
    includesOpenRouterFree &&
    !resolveEnvApiKey("openrouter")?.apiKey &&
    !getCustomProviderApiKey(params.cfg, "openrouter")
  ) {
    warnings.push({
      path: "agents.defaults.modelRouter.routes",
      message:
        "modelRouter includes openrouter/free but OPENROUTER_API_KEY is missing. Set OPENROUTER_API_KEY or remove that fallback.",
    });
  }
  return {
    issues: [],
    warnings,
  };
}

export function assertModelRouterAllowlistSafe(params: {
  cfg: OpenClawConfig;
  plan: ModelPlan;
  defaultProvider: string;
}) {
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  if (!allowlist || allowlist.size === 0) {
    return;
  }
  const refs = [params.plan.primary, ...params.plan.fallbacks];
  const missing = refs
    .map((ref) => modelKey(ref.provider, ref.model))
    .filter((key) => !allowlist.has(key));
  if (missing.length === 0) {
    return;
  }
  throw new ModelRoutingConfigError(
    "agents.defaults.models",
    `modelRouter selected models not present in allowlist: ${missing.join(", ")}. Add them under agents.defaults.models.`,
  );
}
