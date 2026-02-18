# Enhanced Onboarding Wizard Design

## Scope

Add an onboarding profile selector to the existing wizard framework:

- `standard` keeps current behavior
- `enhanced` runs additional deterministic steps for model routing, skills bundles, multi-agent defaults, observability streaming, and final verification

The enhanced flow reuses existing `wizard.start` / `wizard.next` / `wizard.status` / `wizard.cancel` RPC methods and the current prompt-driven session model.

## Step IDs

New canonical wizard step IDs (logical IDs for implementation and tests):

1. `setupProfile`
1. `setupMode` (existing local vs remote selection path)
1. `workspace` (existing local workspace path)
1. `auth` (existing provider auth selection)
1. `gateway` (existing gateway config)
1. `channels` (existing channel setup)
1. `modelStack` (enhanced only)
1. `skillsBundle` (enhanced only)
1. `multiAgent` (enhanced only)
1. `observability` (enhanced only)
1. `finalVerification` (enhanced only)
1. `finalize` (existing completion flow)

## Transitions

Base transitions:

- `setupProfile` -> `setupMode`
- `setupMode=remote` -> `finalize` (remote info-only path, same as current)
- `setupMode=local` -> `workspace` -> `auth` -> `gateway` -> `channels`

Profile transitions:

- `profile=standard`: `channels` -> existing skills/hooks/finalize pipeline
- `profile=enhanced`: `channels` -> `modelStack` -> `skillsBundle` -> `multiAgent` -> `observability` -> `finalVerification` -> `finalize`

Per-step branch behavior:

- If existing configuration is detected, each enhanced step must offer:
  - `keep` (no write)
  - `modify` (merge)
  - `reset` (replace that step scope only; requires explicit confirmation, and `--force` in non-interactive mode)

## Config Outputs

Enhanced flow writes these additional outputs.

### Wizard metadata

- `wizard.lastRunAt`
- `wizard.lastRunProfile` (`standard` | `enhanced`)
- `wizard.lastRunVersion`
- `wizard.lastRunCommit` (if present)
- `wizard.lastRunMode`

### Model stack

- `models.routingProfiles.enhancedDefault`
- `agents.defaults.modelRouter` aligned with enhanced profile routes
- `agents.defaults.models` allowlist entries for all route refs:
  - `openai-codex/gpt-5.3-codex`
  - `ollama/kimi-k2.5:cloud`
  - `ollama/deepseek-v3.2:cloud`
  - `xai/grok-3-fast-latest`
  - `openrouter/free` (or configured free fallback)
- Provider config merge keys (no secret overwrite unless reset/force):
  - `models.providers.ollama.baseUrl` (OpenAI-compatible `/v1` URL accepted)
  - `models.providers.xai.baseUrl` defaults to `https://api.x.ai/v1`
  - OpenRouter provider/auth profile references
  - OpenAI Codex OAuth profile references

### Skills bundle

- `skills.bundles.enhancedCore` (bundle membership)
- `skills.entries.*.enabled` and/or agent-scoped skill enablement fields
- audit gate result surfaced in wizard state (if audit fails, block enable and allow continue with disabled bundle)

### Multi-agent

- `agents.defaults.multiAgent.*`
- `agents.list` ensures `main`, `admin`, `worker`, `social`, `research` entries
- `bindings` merged idempotently, no duplicates
- `session.dmScope` default:
  - `per-account-channel-peer` when multi-account or multi-channel bindings exist
  - otherwise `per-channel-peer`
- `session.identityLinks` merged (no duplicate peers per identity key)

### Observability

- `observability.enabled=true`
- `observability.audit.enabled=true`
- `observability.spend.enabled=true`
- `observability.stream.enabled=true`
- stream defaults:
  - `replayWindowMs`
  - `serverMaxEventsPerSec`
  - `serverMaxBufferedEvents`
  - `messageMaxBytes`

## Validation and Hard Errors

Enhanced validation rules:

- Hard error when routing references model refs not present in `agents.defaults.models`
- Hard error when required provider auth is missing for selected providers unless explicitly downgraded
- OpenRouter fallback:
  - if `openrouter/free` is selected and key is missing, show warning + allow explicit opt-out of free fallback
- Hard error on invalid observability stream numeric bounds
- Skills audit failures block skill enablement, but user may continue with skills disabled

## Idempotency Rules

Re-running enhanced onboarding must be reproducible:

- no duplicate `agents.list` IDs
- no duplicate `bindings` match keys
- no duplicate skills bundle IDs or enabled entries
- no blind overwrite of provider keys/tokens without explicit reset/force
- merge strategy:
  - object fields merged shallow/deep by scope
  - arrays deduplicated by semantic key (`id`, `match`, `skillId`)

## Safety and Recovery

- Step apply functions stage config in-memory, validate, then write once per successful step
- Failed apply returns actionable error and leaves previous valid config intact
- Reset operations require:
  - interactive explicit confirmation
  - `--force` in non-interactive mode

## CLI UX

`openclaw onboard` additions:

- `--profile standard|enhanced`
- `--non-interactive`
- `--force`

Non-interactive enhanced defaults:

- applies enhanced default answers
- fails fast on missing required auth (unless explicit skip behavior is selected)
- prints:
  - config path
  - changed key summary
  - next-step commands
  - Control UI open command

## Control UI UX

Add an onboarding wizard surface in Control UI backed by wizard RPC:

- profile selection first
- enhanced step forms:
  - model stack
  - skills bundle
  - multi-agent
  - observability
- review panel with planned config key changes before apply
- per-step progress and actionable error output

## Implementation Patch Points

- Wizard core:
  - `src/wizard/onboarding.ts`
  - `src/wizard/onboarding.types.ts`
  - new enhanced wizard helper module under `src/wizard/`
- Gateway RPC:
  - `src/gateway/protocol/schema/wizard.ts`
  - `src/gateway/server-methods/wizard.ts`
- CLI:
  - `src/cli/program/register.onboard.ts`
  - `src/commands/onboard-types.ts`
  - `src/commands/onboard.ts`
  - `src/commands/onboard-non-interactive/local.ts`
- Config schema and validation:
  - `src/config/types.openclaw.ts`
  - `src/config/types.models.ts`
  - `src/config/types.skills.ts`
  - `src/config/zod-schema.ts`
  - `src/config/zod-schema.core.ts`
  - `src/config/validation.ts`
- Control UI:
  - `ui/src/ui/navigation.ts`
  - `ui/src/ui/app-view-state.ts`
  - `ui/src/ui/app.ts`
  - `ui/src/ui/app-render.ts`
  - new onboarding view/controller files in `ui/src/ui/views` and `ui/src/ui/controllers`
