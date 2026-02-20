import type { OpenClawConfig } from "../config/config.js";
import {
  observeModelCallEnd,
  observeModelCallError,
  observeModelCallFallback,
  observeModelCallStart,
} from "../infra/observability.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  ensureAuthProfileStore,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { lookupContextTokens } from "./context.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  FailoverError,
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
} from "./failover-error.js";
import {
  assertModelRouterAllowlistSafe,
  resolveModelRoutingDecision,
  type ModelRouterInput,
  type ResolvedModelRouterDecision,
} from "./model-router.js";
import {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  modelKey,
  normalizeModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers.js";

const log = createSubsystemLogger("agents/model-routing");

type ModelCandidate = {
  provider: string;
  model: string;
};

type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};

type ModelFallbackTerminalReason = "invalid_api_key" | "model_not_allowed";

const INVALID_API_KEY_RE =
  /invalid[_\s-]?api[_\s-]?key|incorrect api key|api key.*invalid|authentication.*invalid/i;
const MODEL_NOT_ALLOWED_RE =
  /model.*not allowed|model_not_allowed|allowlist (?:violation|miss|mismatch)|not in allowlist|access.*to model.*denied/i;
const TOOL_CALL_PARSE_RE =
  /tool[_\s-]?call.*(?:parse|parsing|invalid|schema)|invalid tool(?:[\s-]arguments?)?|json parse|unexpected end of json/i;
const RETRYABLE_NETWORK_CODE_RE =
  /^(?:econnrefused|econnreset|etimedout|esockettimedout|ehostunreach|enotfound)$/i;
const RETRYABLE_SERVER_STATUS_MIN = 500;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_WINDOW_MS = 60_000;
const CIRCUIT_BREAKER_OPEN_MS = 60_000;

type CircuitState = {
  failures: number[];
  openUntil?: number;
};

const candidateCircuitState = new Map<string, CircuitState>();

/**
 * Fallback abort check. Only treats explicit AbortError names as user aborts.
 * Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
 */
function isFallbackAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if (isFailoverError(err)) {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isFallbackAbortError(err) && !isTimeoutError(err);
}

function createModelCandidateCollector(allowlist: Set<string> | null | undefined): {
  candidates: ModelCandidate[];
  addCandidate: (candidate: ModelCandidate, enforceAllowlist: boolean) => void;
} {
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) {
      return;
    }
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) {
      return;
    }
    if (enforceAllowlist && allowlist && !allowlist.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  return { candidates, addCandidate };
}

function classifyTerminalErrorReason(err: unknown): ModelFallbackTerminalReason | null {
  const described = describeFailoverError(err);
  const message = described.message || "";
  const code = (described.code ?? "").toLowerCase();
  if (
    INVALID_API_KEY_RE.test(message) ||
    code === "invalid_api_key" ||
    code === "invalid-api-key" ||
    code === "api_key_invalid"
  ) {
    return "invalid_api_key";
  }
  if (MODEL_NOT_ALLOWED_RE.test(message) || code === "model_not_allowed") {
    return "model_not_allowed";
  }
  return null;
}

function buildCandidateKey(provider: string, model: string): string {
  return modelKey(provider, model);
}

function pruneCircuitWindow(state: CircuitState, now: number) {
  state.failures = state.failures.filter(
    (timestamp) => now - timestamp <= CIRCUIT_BREAKER_WINDOW_MS,
  );
}

function isCircuitOpen(provider: string, model: string, now: number): boolean {
  const state = candidateCircuitState.get(buildCandidateKey(provider, model));
  if (!state?.openUntil) {
    return false;
  }
  if (state.openUntil <= now) {
    state.openUntil = undefined;
    pruneCircuitWindow(state, now);
    return false;
  }
  return true;
}

function noteCircuitFailure(params: {
  provider: string;
  model: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
}) {
  const now = Date.now();
  const shouldRecord =
    params.reason === "timeout" ||
    params.reason === "rate_limit" ||
    (typeof params.status === "number" && params.status >= RETRYABLE_SERVER_STATUS_MIN) ||
    (typeof params.code === "string" && RETRYABLE_NETWORK_CODE_RE.test(params.code));
  if (!shouldRecord) {
    return;
  }

  const key = buildCandidateKey(params.provider, params.model);
  const state = candidateCircuitState.get(key) ?? { failures: [] };
  pruneCircuitWindow(state, now);
  state.failures.push(now);
  if (state.failures.length >= CIRCUIT_BREAKER_THRESHOLD) {
    state.openUntil = now + CIRCUIT_BREAKER_OPEN_MS;
  }
  candidateCircuitState.set(key, state);
}

function getRecordStringValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate.trim();
  return trimmed || undefined;
}

function getRecordNumberValue(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }
  return undefined;
}

function coerceRetryableFailoverError(params: {
  err: unknown;
  provider: string;
  model: string;
}): FailoverError | null {
  const direct = coerceToFailoverError(params.err, {
    provider: params.provider,
    model: params.model,
  });
  if (direct) {
    return direct;
  }
  const described = describeFailoverError(params.err);
  const message = described.message || "";
  const code = described.code ?? getRecordStringValue(params.err, "code");
  const status = described.status ?? getRecordNumberValue(params.err, "status");
  const lower = message.toLowerCase();
  if (
    (typeof status === "number" && status >= RETRYABLE_SERVER_STATUS_MIN) ||
    (typeof code === "string" && RETRYABLE_NETWORK_CODE_RE.test(code))
  ) {
    return new FailoverError(message || "retryable transport error", {
      reason: "timeout",
      provider: params.provider,
      model: params.model,
      status,
      code,
      cause: params.err instanceof Error ? params.err : undefined,
    });
  }
  if (TOOL_CALL_PARSE_RE.test(lower)) {
    return new FailoverError(message || "tool-call parse failure", {
      reason: "format",
      provider: params.provider,
      model: params.model,
      status,
      code,
      cause: params.err instanceof Error ? params.err : undefined,
    });
  }
  return null;
}

function extractTokenUsage(result: unknown): { tokensIn?: number; tokensOut?: number } {
  if (!result || typeof result !== "object") {
    return {};
  }
  const meta = (result as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") {
    return {};
  }
  const agentMeta = (meta as { agentMeta?: unknown }).agentMeta;
  if (!agentMeta || typeof agentMeta !== "object") {
    return {};
  }
  const usage = (agentMeta as { usage?: unknown }).usage;
  if (usage && typeof usage === "object") {
    const tokensIn = getRecordNumberValue(usage, "input");
    const tokensOut = getRecordNumberValue(usage, "output");
    if (tokensIn !== undefined || tokensOut !== undefined) {
      return { tokensIn, tokensOut };
    }
  }
  const promptTokens = getRecordNumberValue(agentMeta, "promptTokens");
  const outputTokens = getRecordNumberValue(agentMeta, "outputTokens");
  return { tokensIn: promptTokens, tokensOut: outputTokens };
}

function formatTerminalError(reason: ModelFallbackTerminalReason, err: unknown): Error {
  const described = describeFailoverError(err);
  const message = described.message || "model request failed";
  if (reason === "model_not_allowed") {
    return new Error(
      `Model request blocked by allowlist or provider policy: ${message}. Fix agents.defaults.models / model allowlist configuration and retry.`,
    );
  }
  return new Error(
    `Model authentication failed (${reason}): ${message}. Fix provider credentials before retrying.`,
  );
}

function estimateModelContextWindow(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
}): number | undefined {
  const direct = params.cfg?.models?.providers?.[params.provider]?.models?.find(
    (candidate) => candidate.id === params.model,
  )?.contextWindow;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct);
  }
  const discovered = lookupContextTokens(params.model);
  if (typeof discovered === "number" && Number.isFinite(discovered) && discovered > 0) {
    return Math.floor(discovered);
  }
  return undefined;
}

function resolveNextLikelyLargerContextCandidate(params: {
  cfg: OpenClawConfig | undefined;
  candidates: ModelCandidate[];
  startIndex: number;
  failedProvider: string;
  failedModel: string;
}): number | null {
  const failedWindow = estimateModelContextWindow({
    cfg: params.cfg,
    provider: params.failedProvider,
    model: params.failedModel,
  });
  if (params.startIndex >= params.candidates.length) {
    return null;
  }
  if (failedWindow === undefined) {
    return params.startIndex;
  }
  let firstUnknown: number | null = null;
  for (let i = params.startIndex; i < params.candidates.length; i += 1) {
    const candidate = params.candidates[i];
    if (!candidate) {
      continue;
    }
    const contextWindow = estimateModelContextWindow({
      cfg: params.cfg,
      provider: candidate.provider,
      model: candidate.model,
    });
    if (contextWindow === undefined) {
      if (firstUnknown === null) {
        firstUnknown = i;
      }
      continue;
    }
    if (contextWindow > failedWindow) {
      return i;
    }
  }
  return firstUnknown;
}

function emitModelRoutingLog(params: {
  requestId?: string;
  chosenModel?: { provider: string; model: string };
  attempts: FallbackAttempt[];
  failReason?: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
}) {
  const payload = {
    request_id: params.requestId ?? "",
    chosen_model: params.chosenModel
      ? `${params.chosenModel.provider}/${params.chosenModel.model}`
      : null,
    fallback_hops: params.attempts.map((attempt) => `${attempt.provider}/${attempt.model}`),
    fail_reason: params.failReason ?? null,
    latency_ms: params.latencyMs,
    tokens_in: params.tokensIn ?? null,
    tokens_out: params.tokensOut ?? null,
  };
  log.info(`[model-routing] ${JSON.stringify(payload)}`);
}

type ModelFallbackErrorHandler = (attempt: {
  provider: string;
  model: string;
  error: unknown;
  attempt: number;
  total: number;
}) => void | Promise<void>;

type ModelFallbackRunResult<T> = {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
};

function resolveRoutingDecision(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  fallbacksOverride?: string[];
  routerInput?: ModelRouterInput;
  preserveNonDefaultSelection?: boolean;
  routerDebug?: boolean;
}): {
  provider: string;
  model: string;
  fallbacksOverride?: string[];
  decision?: ResolvedModelRouterDecision;
} {
  if (!params.cfg || !params.routerInput) {
    return {
      provider: params.provider,
      model: params.model,
      fallbacksOverride: params.fallbacksOverride,
    };
  }
  const decision = resolveModelRoutingDecision({
    cfg: params.cfg,
    input: params.routerInput,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
    preserveNonDefaultSelection: params.preserveNonDefaultSelection ?? true,
    forceDebug: params.routerDebug,
  });
  if (decision.plan) {
    assertModelRouterAllowlistSafe({
      cfg: params.cfg,
      plan: decision.plan,
      defaultProvider: DEFAULT_PROVIDER,
    });
  }
  return {
    provider: decision.provider,
    model: decision.model,
    fallbacksOverride: decision.fallbacksOverride,
    decision,
  };
}

export function __resetModelFallbackCircuitForTests() {
  candidateCircuitState.clear();
}

function resolveImageFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
  modelOverride?: string;
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const { candidates, addCandidate } = createModelCandidateCollector(allowlist);

  const addRaw = (raw: string, enforceAllowlist: boolean) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    addCandidate(resolved.ref, enforceAllowlist);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride, false);
  } else {
    const imageModel = params.cfg?.agents?.defaults?.imageModel as
      | { primary?: string }
      | string
      | undefined;
    const primary = typeof imageModel === "string" ? imageModel.trim() : imageModel?.primary;
    if (primary?.trim()) {
      addRaw(primary, false);
    }
  }

  const imageFallbacks = (() => {
    const imageModel = params.cfg?.agents?.defaults?.imageModel as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (imageModel && typeof imageModel === "object") {
      return imageModel.fallbacks ?? [];
    }
    return [];
  })();

  for (const raw of imageFallbacks) {
    addRaw(raw, true);
  }

  return candidates;
}

function resolveFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
}): ModelCandidate[] {
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = String(params.provider ?? "").trim() || defaultProvider;
  const modelRaw = String(params.model ?? "").trim() || defaultModel;
  const normalizedPrimary = normalizeModelRef(providerRaw, modelRaw);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
  });
  const { candidates, addCandidate } = createModelCandidateCollector(allowlist);

  addCandidate(normalizedPrimary, false);

  const modelFallbacks = (() => {
    if (params.fallbacksOverride !== undefined) {
      return params.fallbacksOverride;
    }
    const model = params.cfg?.agents?.defaults?.model as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (model && typeof model === "object") {
      return model.fallbacks ?? [];
    }
    return [];
  })();

  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    addCandidate(resolved.ref, true);
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addCandidate({ provider: primary.provider, model: primary.model }, false);
  }

  return candidates;
}

const lastProbeAttempt = new Map<string, number>();
const MIN_PROBE_INTERVAL_MS = 30_000; // 30 seconds between probes per key
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";

function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = String(agentDir ?? "").trim();
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function shouldProbePrimaryDuringCooldown(params: {
  isPrimary: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  throttleKey: string;
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  profileIds: string[];
}): boolean {
  if (!params.isPrimary || !params.hasFallbackCandidates) {
    return false;
  }

  const lastProbe = lastProbeAttempt.get(params.throttleKey) ?? 0;
  if (params.now - lastProbe < MIN_PROBE_INTERVAL_MS) {
    return false;
  }

  const soonest = getSoonestCooldownExpiry(params.authStore, params.profileIds);
  if (soonest === null || !Number.isFinite(soonest)) {
    return true;
  }

  // Probe when cooldown already expired or within the configured margin.
  return params.now >= soonest - PROBE_MARGIN_MS;
}

/** @internal – exposed for unit tests only */
export const _probeThrottleInternals = {
  lastProbeAttempt,
  MIN_PROBE_INTERVAL_MS,
  PROBE_MARGIN_MS,
  resolveProbeThrottleKey,
} as const;

export async function runWithModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentDir?: string;
  agentId?: string;
  requestId?: string;
  routerInput?: ModelRouterInput;
  preserveNonDefaultSelection?: boolean;
  routerDebug?: boolean;
  onRouterDecision?: (decision: ResolvedModelRouterDecision) => void;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const startedAt = Date.now();
  const routed = resolveRoutingDecision({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
    routerInput: params.routerInput,
    preserveNonDefaultSelection: params.preserveNonDefaultSelection,
    routerDebug: params.routerDebug,
  });
  if (routed.decision) {
    params.onRouterDecision?.(routed.decision);
  }
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: routed.provider,
    model: routed.model,
    fallbacksOverride: routed.fallbacksOverride,
  });
  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;
  const attempts: FallbackAttempt[] = [];
  const observabilityRequestId =
    params.requestId ??
    `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let lastError: unknown;
  let lastFailReason: string | undefined;

  const hasFallbackCandidates = candidates.length > 1;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const requestId = observabilityRequestId;
    const attemptStart = Date.now();
    observeModelCallStart(
      {
        requestId,
        provider: candidate.provider,
        model: candidate.model,
        agentId: params.agentId,
        attempt: i + 1,
        total: candidates.length,
      },
      params.cfg,
    );
    const now = Date.now();
    if (isCircuitOpen(candidate.provider, candidate.model, now)) {
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: `Circuit breaker open for ${candidate.provider}/${candidate.model}`,
        reason: "rate_limit",
      });
      lastFailReason = "circuit_open";
      observeModelCallError(
        {
          requestId,
          provider: candidate.provider,
          model: candidate.model,
          reason: "circuit_open",
          error: "circuit breaker open",
          agentId: params.agentId,
        },
        params.cfg,
      );
      const next = candidates[i + 1];
      if (next) {
        observeModelCallFallback(
          {
            requestId,
            fromProvider: candidate.provider,
            fromModel: candidate.model,
            toProvider: next.provider,
            toModel: next.model,
            reason: "circuit_open",
            agentId: params.agentId,
          },
          params.cfg,
        );
      }
      continue;
    }
    if (authStore) {
      const profileIds = resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
      });
      const isAnyProfileAvailable = profileIds.some((id) => !isProfileInCooldown(authStore, id));

      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        // All profiles for this provider are in cooldown.
        // For the primary model (i === 0), probe it if the soonest cooldown
        // expiry is close or already past. This avoids staying on a fallback
        // model long after the real rate-limit window clears.
        const now = Date.now();
        const probeThrottleKey = resolveProbeThrottleKey(candidate.provider, params.agentDir);
        const shouldProbe = shouldProbePrimaryDuringCooldown({
          isPrimary: i === 0,
          hasFallbackCandidates,
          now,
          throttleKey: probeThrottleKey,
          authStore,
          profileIds,
        });
        if (!shouldProbe) {
          // Skip without attempting
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error: `Provider ${candidate.provider} is in cooldown (all profiles unavailable)`,
            reason: "rate_limit",
          });
          lastFailReason = "provider_cooldown";
          observeModelCallError(
            {
              requestId,
              provider: candidate.provider,
              model: candidate.model,
              reason: "provider_cooldown",
              error: "provider cooldown",
              agentId: params.agentId,
            },
            params.cfg,
          );
          const next = candidates[i + 1];
          if (next) {
            observeModelCallFallback(
              {
                requestId,
                fromProvider: candidate.provider,
                fromModel: candidate.model,
                toProvider: next.provider,
                toModel: next.model,
                reason: "provider_cooldown",
                agentId: params.agentId,
              },
              params.cfg,
            );
          }
          continue;
        }
        // Primary model probe: attempt it despite cooldown to detect recovery.
        // If it fails, the error is caught below and we fall through to the
        // next candidate as usual.
        lastProbeAttempt.set(probeThrottleKey, now);
      }
    }
    try {
      const result = await params.run(candidate.provider, candidate.model);
      const usage = extractTokenUsage(result);
      observeModelCallEnd(
        {
          requestId,
          provider: candidate.provider,
          model: candidate.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          latencyMs: Date.now() - attemptStart,
          agentId: params.agentId,
        },
        params.cfg,
      );
      emitModelRoutingLog({
        requestId: params.requestId,
        chosenModel: {
          provider: candidate.provider,
          model: candidate.model,
        },
        attempts,
        latencyMs: Date.now() - startedAt,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
      });
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      if (shouldRethrowAbort(err)) {
        emitModelRoutingLog({
          requestId: params.requestId,
          attempts,
          failReason: "abort",
          latencyMs: Date.now() - startedAt,
        });
        throw err;
      }
      const errMessage = err instanceof Error ? err.message : String(err);
      const terminalReason = classifyTerminalErrorReason(err);
      if (terminalReason) {
        observeModelCallError(
          {
            requestId,
            provider: candidate.provider,
            model: candidate.model,
            reason: terminalReason,
            error: err,
            agentId: params.agentId,
          },
          params.cfg,
        );
        const terminal = formatTerminalError(terminalReason, err);
        emitModelRoutingLog({
          requestId: params.requestId,
          attempts,
          failReason: terminalReason,
          latencyMs: Date.now() - startedAt,
        });
        throw terminal;
      }
      if (isLikelyContextOverflowError(errMessage)) {
        const nextIndex = resolveNextLikelyLargerContextCandidate({
          cfg: params.cfg,
          candidates,
          startIndex: i + 1,
          failedProvider: candidate.provider,
          failedModel: candidate.model,
        });
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          error: errMessage || "context length exceeded",
        });
        lastError = err;
        lastFailReason = "context_overflow";
        observeModelCallError(
          {
            requestId,
            provider: candidate.provider,
            model: candidate.model,
            reason: "context_overflow",
            error: errMessage,
            agentId: params.agentId,
          },
          params.cfg,
        );
        if (nextIndex === null) {
          break;
        }
        const next = candidates[nextIndex];
        if (next) {
          observeModelCallFallback(
            {
              requestId,
              fromProvider: candidate.provider,
              fromModel: candidate.model,
              toProvider: next.provider,
              toModel: next.model,
              reason: "context_overflow",
              agentId: params.agentId,
            },
            params.cfg,
          );
        }
        // Skip directly to the next larger-context candidate.
        i = nextIndex - 1;
        continue;
      }
      const normalized = coerceRetryableFailoverError({
        err,
        provider: candidate.provider,
        model: candidate.model,
      });
      if (!normalized || !isFailoverError(normalized)) {
        observeModelCallError(
          {
            requestId,
            provider: candidate.provider,
            model: candidate.model,
            reason: "non_retryable_error",
            error: err,
            agentId: params.agentId,
          },
          params.cfg,
        );
        emitModelRoutingLog({
          requestId: params.requestId,
          attempts,
          failReason: "non_retryable_error",
          latencyMs: Date.now() - startedAt,
        });
        throw err;
      }

      lastError = normalized;
      const described = describeFailoverError(normalized);
      lastFailReason = described.reason ?? "retryable_error";
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described.message,
        reason: described.reason,
        status: described.status,
        code: described.code,
      });
      observeModelCallError(
        {
          requestId,
          provider: candidate.provider,
          model: candidate.model,
          reason: described.reason ?? "retryable_error",
          statusCode: described.status,
          errorCode: described.code,
          error: described.message,
          agentId: params.agentId,
        },
        params.cfg,
      );
      const next = candidates[i + 1];
      if (next) {
        observeModelCallFallback(
          {
            requestId,
            fromProvider: candidate.provider,
            fromModel: candidate.model,
            toProvider: next.provider,
            toModel: next.model,
            reason: described.reason,
            agentId: params.agentId,
          },
          params.cfg,
        );
      }
      noteCircuitFailure({
        provider: candidate.provider,
        model: candidate.model,
        reason: described.reason,
        status: described.status,
        code: described.code,
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: normalized,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  if (attempts.length <= 1 && lastError) {
    emitModelRoutingLog({
      requestId: params.requestId,
      attempts,
      failReason: lastFailReason ?? "single_failure",
      latencyMs: Date.now() - startedAt,
    });
    throw lastError;
  }
  const summary =
    attempts.length > 0
      ? attempts
          .map(
            (attempt) =>
              `${attempt.provider}/${attempt.model}: ${attempt.error}${
                attempt.reason ? ` (${attempt.reason})` : ""
              }`,
          )
          .join(" | ")
      : "unknown";
  emitModelRoutingLog({
    requestId: params.requestId,
    attempts,
    failReason: lastFailReason ?? "all_models_failed",
    latencyMs: Date.now() - startedAt,
  });
  throw new Error(`All models failed (${attempts.length || candidates.length}): ${summary}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

export async function runWithImageModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveImageFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const result = await params.run(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      if (shouldRethrowAbort(err)) {
        throw err;
      }
      lastError = err;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: err instanceof Error ? err.message : String(err),
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  if (attempts.length <= 1 && lastError) {
    throw lastError;
  }
  const summary =
    attempts.length > 0
      ? attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`)
          .join(" | ")
      : "unknown";
  throw new Error(`All image models failed (${attempts.length || candidates.length}): ${summary}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}
