# Feature Inventory (feature branch vs origin/main)

Branch: `feat__openclaw-enhancements`
Base compared: `origin/main` (local cached ref)

## A) Models / Routing Profiles + Allowlists

Key commits:
- `b43da05d5` phase 5 model orchestration router
- `652e8f11c` resilient model fallback execution + routing hooks
- `c1f231589` router fallback tests and snapshots

Primary files:
- `src/agents/model-router.ts`
- `src/agents/model-fallback.ts`
- `src/agents/model-selection.ts`
- `src/routing/resolve-route.ts`
- `src/routing/bindings.ts`
- `config/model-priority.json`
- `config/examples/openclaw.phase5.json`
- `docs/phase-5-model-routing.md`

## B) Subagents / Delegation Primitives

Key commits:
- `8f9508748` agents.call + agents.message + loop guards
- `6dc8af1c2` artifacts content-addressed store + audit events
- `302dc1c47` bindings explain + routing decision events

Primary files:
- `src/agents/openclaw-tools.ts`
- `src/agents/openclaw-tools.subagents.*`
- `src/agents/artifacts.ts`
- `src/routing/bindings.ts`
- `ui/src/ui/views/delegation-activity.ts`
- `docs/MULTI_AGENT_WORKFLOWS.md`
- `docs/phase-8-multi-agent-design.md`

## C) Observability Phase 6/7 + Control UI

Key commits:
- `15d6fba0d` audit logging + redaction + sinks
- `d749f723f` tracing + spend + health
- `f4b209515` backend event bus + ring buffer + websocket handlers
- `689033ab8` UI stream client + state store
- `c50cdeaaa` UI Live Audit + Spend + Health pages

Primary files:
- `packages/observability/**`
- `src/observability/stream-protocol.ts`
- `src/infra/observability.ts`
- `ui/src/services/observability-stream.ts`
- `ui/src/services/observability-store.ts`
- `ui/src/ui/views/observability.ts`
- `docs/phase-6-observability.md`
- `docs/OBSERVABILITY_UI.md`

## D) Enhanced Onboarding Wizard (Phase 9.1)

Key commits:
- `c1e67f277` profile selection + schemas + design
- `b6c203eb9` enhanced steps + idempotent config writes
- `3f0473b08` onboard flags + non-interactive enhanced path
- `e15e3f8a5` onboarding UI enhanced steps
- `docs(onboarding)` docs + examples

Primary files:
- `src/wizard/onboarding.enhanced.ts`
- `src/wizard/onboarding.ts`
- `src/wizard/prompts.ts`
- `src/commands/onboard.ts`
- `src/commands/onboard-enhanced-profile.ts`
- `src/commands/onboard-non-interactive.ts`
- `ui/src/ui/views/onboarding-wizard.ts`
- `config/examples/openclaw.enhanced.json`
- `docs/ONBOARDING_ENHANCED.md`

## E) CLI Ops Commands (Phase 9.2)

Observed feature-branch ops surfaces:
- observability/spend command surfaces and helpers
- onboarding/profile/agents command expansions
- gateway status + health additions used by enhanced flow

Representative files:
- `src/commands/health.ts`
- `src/commands/gateway-status.ts`
- `src/commands/onboard*.ts`
- `src/commands/agents*.ts`

## F) Policy / Security / Web Allowlists / Sandbox

Key touched areas in feature branch:
- security auditing and fix flows
- exec approval analysis and allowlist code
- SSRF/fetch guard enforcement
- doctor/config validation surfaces tied to onboarding + routing

Primary files:
- `src/security/*`
- `src/infra/net/ssrf.ts`
- `src/infra/exec-approvals.ts`
- `src/commands/doctor*.ts`
- `src/commands/config-validation.ts`

## Merge-Risk Summary

Highest-risk overlap with upstream changelog:
- `src/agents/openclaw-tools.ts` and `src/agents/openclaw-tools.subagents.*` (subagent spawn + context compaction/truncation)
- `src/agents/model-*` and config model catalog paths (Anthropic 1M + Sonnet 4.6 + thinking defaults)
- `src/infra/net/*` and web tools for URL allowlists
- `src/commands/doctor*.ts` and config include path confinement
- `ui/src/ui/views/*`, `src/slack/*`, `src/telegram/*`, `src/imessage/*` (streaming/threading preservation)
- `src/wizard/*`, `src/commands/onboard*.ts`, `ui/src/ui/views/onboarding-wizard.ts` (onboarding/iOS-adjacent fixes)
