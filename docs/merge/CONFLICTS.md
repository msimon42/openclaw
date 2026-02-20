# Merge Conflict Resolutions

- file: `package.json`
  upstream: version/dependency/toolchain updates (2026.2.18, pi 0.53.0, oxlint/oxfmt, script updates).
  ours: feature-branch scripts and phase-related command wiring.
  final decision: combined. Kept upstream release/dependency updates and preserved feature scripts needed by Phases 5-9.

- file: `pnpm-lock.yaml`
  upstream: lockfile refresh for dependency/version changes.
  ours: lockfile from feature branch dependency graph.
  final decision: combined. Kept upstream lock refresh while preserving feature-branch package graph entries.

- file: `src/agents/model-fallback.ts`
  upstream: fallback/auth cooldown and failover refinements.
  ours: routing-profile/model-router allowlist protections and phase fallback behavior.
  final decision: combined. Preserved phase routing/fallback behavior and kept upstream failover/cooldown logic.

- file: `src/agents/openclaw-tools.ts`
  upstream: tool wiring cleanup and canvas/config updates.
  ours: delegation tools (`call_agent`/`message_agent`/artifacts) and run-scoped controls.
  final decision: combined (ours-priority for capabilities). Delegation/artifact tools retained; upstream safe wiring updates kept.

- file: `src/agents/pi-tool-definition-adapter.ts`
  upstream: tool execute signature/order adjustments and stricter typing.
  ours: hook context and compatibility support.
  final decision: combined. Supports both execute arg layouts and keeps hook-context compatibility.

- file: `src/agents/pi-tools.before-tool-call.ts`
  upstream: loop-detection integration and warning bucketing.
  ours: skill policy guard + blocked-event observability.
  final decision: combined. Retains security guardrails and adds upstream loop detection behavior.

- file: `src/agents/pi-tools.ts`
  upstream: read/context-budget and image/tool normalization improvements.
  ours: phase tool assembly, delegation hooks, policy pipeline behavior.
  final decision: combined. Preserved phase tool behavior; adopted upstream loop/read/context improvements.

- file: `src/agents/skills.agents-skills-directory.e2e.test.ts`
  upstream: helper extraction/cleanup in test scaffolding.
  ours: skill directory precedence and phase-specific coverage.
  final decision: combined. Kept upstream test helper cleanup and retained precedence assertions.

- file: `src/agents/skills/workspace.ts`
  upstream: path compaction (`~`) and prompt truncation refinements.
  ours: workspace/personal/managed skill precedence logic.
  final decision: combined. Kept precedence behavior and upstream compaction/truncation improvements.

- file: `src/auto-reply/reply/agent-runner-execution.ts`
  upstream: runner stability and context-overflow handling updates.
  ours: phase execution/delegation behavior.
  final decision: combined. Preserved phase execution flow and incorporated upstream overflow/stability fixes.

- file: `src/auto-reply/reply/agent-runner-memory.ts`
  upstream: memory flush/context-window handling updates.
  ours: phase memory/delegation integration.
  final decision: combined. Keeps feature behavior and upstream context-window safety.

- file: `src/commands/onboard-helpers.ts`
  upstream: onboarding/runtime helper hardening and path handling updates.
  ours: enhanced onboarding wizard flow support.
  final decision: combined. Gateway-driven enhanced onboarding preserved with upstream helper hardening.

- file: `src/gateway/server-methods.ts`
  upstream: method/scope map updates and additional handlers.
  ours: observability/delegation method exposure.
  final decision: combined. Kept upstream scope adjustments and preserved observability + delegation endpoints.

- file: `src/gateway/server-methods/agents.ts`
  upstream: large handler refactor reducing/relocating logic.
  ours: `agents.call`/`agents.message` + artifacts delegation implementation.
  final decision: ours-priority with selective upstream adoption. Delegation/artifact handlers retained to avoid phase regressions.

- file: `src/gateway/server.impl.ts`
  upstream: channel health monitor and startup/shutdown refinements.
  ours: observability stream wiring and enhanced wizard integration.
  final decision: combined. Kept observability stream + channel health monitor; removed duplicate shutdown stop call artifact.

- file: `src/plugins/loader.ts`
  upstream: plugin loader cleanup.
  ours: plugin lifecycle observability/error reporting.
  final decision: combined (ours-priority for telemetry). Preserved lifecycle observability while retaining upstream structure cleanup.

- file: `src/process/exec.test.ts`
  upstream: timing stabilization and timeout reliability tweaks.
  ours: existing exec expectations.
  final decision: combined. Adopted upstream stable timings while preserving expected behavior assertions.

- file: `ui/src/ui/app-gateway.ts`
  upstream: gateway-event handling simplification.
  ours: observability stream bridge and onboarding-aware event handling.
  final decision: ours-priority with compatibility. Observability/onboarding flows retained; upstream-safe typing/import cleanup included.

- file: `ui/src/ui/app-render.ts`
  upstream: i18n wiring and some controller/render refactors.
  ours: onboarding page, observability pages, inbox, delegation activity UI.
  final decision: combined (ours-priority for net-new tabs). Preserved phase UI surfaces and adopted upstream i18n/controller updates.

- file: `ui/src/ui/app.ts`
  upstream: i18n controller/lifecycle changes.
  ours: observability stream state + onboarding/enhanced control UI state.
  final decision: combined. Upstream i18n initialization retained without dropping phase observability/onboarding state.

- file: `ui/src/ui/navigation.ts`
  upstream: simplified tab set and translated labels.
  ours: extended tab set (onboarding/observability/inbox/delegation).
  final decision: combined (ours-priority for capabilities). Kept extended tabs and switched title/subtitle rendering to i18n keys.
