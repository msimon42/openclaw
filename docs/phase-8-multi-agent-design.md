# Phase 8 Multi-Agent Design

## Goals

- Isolated agents with dedicated workspace, `agentDir`, and sessions.
- Deterministic inbound routing with explainable bindings.
- Context discipline via artifact-first handoffs.
- Bounded delegation (`agents.call`, `agents.message`) with loop guards.
- Full observability for routing, delegation, and artifact flow.
- Operability from existing Control UI.

## Workspace and State Layout

Workspace layout (project-local):

```text
workspaces/
  agents/<agentId>/
    SOUL.md
    policy.json
    skills/
    memory/
    tasks/
    notes/
  _shared/
    BOARD.md
    artifacts/
    briefs/
```

Agent runtime state (unchanged OpenClaw convention):

```text
~/.openclaw/agents/<agentId>/agent/
~/.openclaw/agents/<agentId>/sessions/
```

## API Contracts

### `agents.message`

Async inbox injection only; no run:

- input: `{ fromAgentId, toAgentId, traceId, sessionKey?, message, artifactRefs?, priority? }`
- default `sessionKey`: `agent:<toAgentId>:inbox`
- behavior: append transcript message only
- emits: `agent.message`

### `agents.call`

Bounded synchronous delegation:

- input: `{ fromAgentId, toAgentId, traceId, sessionKey?, message, artifactRefs?, limits?, expectedSchema? }`
- default delegated `sessionKey`: `agent:<toAgentId>:workflow:<traceId>`
- behavior: executes normal agent run under guardrails
- output: `{ status, summary, artifacts, error? }`
  - `summary` max 800 chars
  - returns artifact refs, not transcript
- emits: `agent.call.start`, `agent.call.end`, `agent.call.error`

### `artifacts.publish` / `artifacts.fetch`

Content-addressed shared artifacts:

- `artifactId = art_<sha256(contentBytes)>`
- store payload at `workspaces/_shared/artifacts/<artifactId>.json`
- store metadata at `workspaces/_shared/artifacts/<artifactId>.meta.json`
- brief handoffs at `workspaces/_shared/briefs/<traceId>-<from>-to-<to>.json`
- emits: `artifact.publish`, `artifact.fetch`

## Context Discipline

- Inter-agent payloads are compact briefs + `artifactRefs`.
- Oversized messages are auto-published as artifacts and replaced with refs.
- Delegated runs use workflow session keys, not main inbox sessions.

## Guardrails and Defaults

Delegation defaults:

- `timeoutMs`: `120000`
- `maxDepth`: `3`
- `maxCallsPerTrace`: `8`
- `maxToolCalls`: `24`
- `dedupeWindowMs`: `60000`
- `pairRateLimitPerMinute`: `6`

Loop prevention:

- per-trace depth ceiling
- per-trace call ceiling
- per-agent-pair rate limiting
- task dedupe by `taskHash = sha256(toAgentId + normalizedMessage + artifactRefs + sessionKey)`

## Routing Explainability

Bindings explain reports:

- selected `agentId`
- matched rule id
- specificity tier
- fallback path

Validation warnings:

- ambiguous overlapping bindings
- bindings that reference missing agents
- risky DM scope defaults in multi-account/multi-channel deployments

## Observability

Required event families:

- `routing.decision`
- `agent.call.start|end|error`
- `agent.message`
- `artifact.publish|fetch`

All events carry:

- `traceId`, `agentId`, `eventId`
- delegation context (`fromAgentId`, `toAgentId`, limits, taskHash)
- artifact ids where applicable
