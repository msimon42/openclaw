# Multi-Agent Workflows

This guide covers production multi-agent operation in OpenClaw with strict isolation, bounded delegation, artifact-first handoffs, and full traceability.

## Isolation Model

- Keep each agent workspace isolated at `workspaces/agents/<agentId>`.
- Keep shared collaboration assets under `workspaces/_shared/`.
- Keep runtime state isolated by agent:
  - `~/.openclaw/agents/<agentId>/agent`
  - `~/.openclaw/agents/<agentId>/sessions`
- Never reuse one `agentDir` for multiple agents.
- Prefer separate workspaces per agent; shared workspaces are allowed but warned.

## Agent Templates and Init

Initialize an agent workspace from a role template:

```bash
openclaw agents init worker --template worker
openclaw agents init admin --template admin --workspace ./workspaces/agents/admin
```

Supported templates:

- `admin`
- `worker`
- `social`
- `research`

Each template includes:

- `SOUL.md` role contract
- `policy.json` tool permission expectations
- model routing preference tags (for router mapping)

## Delegation Primitives

Use delegation tools to keep context small and deterministic.

### `call_agent`

Synchronous bounded delegation to run work now.

- returns compact `summary` and `artifacts`
- never returns full transcript
- enforced by depth/call/rate/dedupe guardrails

### `message_agent`

Asynchronous inbox handoff without execution.

- injects message to recipient inbox session
- default inbox session: `agent:<toAgentId>:inbox`
- picked up later by human review, cron, or explicit call

### Artifacts

Shared outputs are content addressed:

- `artifactId = art_<sha256(content)>`
- payloads: `workspaces/_shared/artifacts`
- handoff briefs: `workspaces/_shared/briefs`

Publish large payloads as artifacts and delegate by reference.

## Context Discipline Rules

- Prefer short handoff briefs plus `artifactRefs`.
- Do not forward full transcripts between agents.
- Use workflow-scoped delegated sessions:
  - `agent:<toAgentId>:workflow:<trace>`
- Auto-compact oversized payloads to artifacts.

## Loop Prevention and Safety Defaults

Default delegation limits:

- `timeoutMs: 120000`
- `maxDepth: 3`
- `maxCallsPerTrace: 8`
- `maxToolCalls: 24`
- `dedupeWindowMs: 60000`
- `pairRateLimitPerMinute: 6`

Guardrails:

- per-trace depth cap
- per-trace call cap
- per-agent-pair rate cap
- task dedupe by task hash

## Routing Explainability

Use bindings explain to audit deterministic routing:

```bash
openclaw bindings explain --channel telegram --account default --peer 12345 --peer-kind direct
```

Output includes:

- selected `agentId`
- matched binding rule id
- specificity score
- default fallback path

### DM Scope Safety

For multi-account or multi-channel direct messages, avoid `dmScope=main` unless you intentionally want merged DM context.

Safer options:

- `dmScope=per-peer`
- `dmScope=per-channel-peer`
- `dmScope=per-account-channel-peer`

Example:

```json
{
  "session": {
    "dmScope": "per-account-channel-peer"
  }
}
```

## Observability and Audit Events

Delegation and artifacts emit stream/audit events:

- `routing.decision`
- `agent.call.start`
- `agent.call.end`
- `agent.call.error`
- `agent.message`
- `artifact.publish`
- `artifact.fetch`

All include `traceId` and agent context so traces remain reconstructable end to end.

`request.end` metrics include delegation counters:

- `delegationCalls`
- `delegationMessages`
- `artifactsPublished`
- `artifactsFetched`

## Control UI Operations

Use the existing Control UI:

1. Select an active agent in the global topbar selector.
2. Open `Inbox` to review injected async handoffs.
3. Promote inbox messages to artifacts or call a worker immediately.
4. Open `Delegation` for recent call/message/artifact activity grouped by trace.
5. Open `Observability` trace view to inspect delegation waterfalls and artifact IDs.
