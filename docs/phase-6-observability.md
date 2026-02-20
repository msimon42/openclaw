---
title: Phase 6 Observability
summary: Configure audit logging, tracing correlation, spend tracking, and health events.
---

## Enable

Copy the example and merge into your OpenClaw config:

```json
{
  "observability": {
    "enabled": true,
    "redactionMode": "strict"
  }
}
```

Example file: `config/examples/openclaw.phase6.observability.json`

## Verify

```bash
openclaw obs verify
openclaw obs tail --today --pretty
openclaw spend report --today
```

## Event fields

Every audit event includes:

- `schemaVersion`
- `eventVersion`
- `timestamp`
- `traceId`
- `agentId`
- `eventType`
- `payload`

When available, events also include model/tool metadata, decision details, and metrics.

## Storage

- Audit JSONL: `./openclaw-data/audit/YYYY-MM-DD.jsonl`
- Spend JSONL: `./openclaw-data/spend/YYYY-MM.jsonl`
- Spend summary: `./openclaw-data/spend/summary.json`
