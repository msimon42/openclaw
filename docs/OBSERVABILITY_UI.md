# Observability UI Streaming

OpenClaw Control UI can render live audit, spend, and model health updates over the Gateway WebSocket stream.

## Enable streaming

Add this block to your config:

```json
{
  "observability": {
    "enabled": true,
    "stream": {
      "enabled": true,
      "replayWindowMs": 300000,
      "serverMaxEventsPerSec": 50,
      "serverMaxBufferedEvents": 10000,
      "messageMaxBytes": 65536
    }
  }
}
```

Default behavior:

- `observability.stream.enabled` defaults to `true` in non-production environments.
- `observability.stream.enabled` defaults to `false` in production.

## WebSocket auth

The stream uses the same Gateway WS auth/session and scopes as Control UI.

- Operator scopes are required.
- Subscription methods:
  - `OBS.SUBSCRIBE`
  - `OBS.UNSUBSCRIBE`
  - `OBS.PING`
- Stream events:
  - `OBS.SNAPSHOT`
  - `OBS.EVENT`
  - `OBS.HEALTH`
  - `OBS.SPEND`
  - `OBS.PONG`
  - `OBS.ERROR`

## Troubleshooting

No events in UI:

- Verify `observability.enabled=true` and `observability.stream.enabled=true`.
- Confirm Control UI hello features include `OBS.SUBSCRIBE` and `OBS.EVENT`.
- Check that runtime emits audit events (for example tool/model calls).

Too many drops:

- Reduce client request rate (`maxEventsPerSec` in `OBS.SUBSCRIBE`).
- Increase `observability.stream.serverMaxBufferedEvents`.
- Increase `observability.stream.messageMaxBytes` if messages are being dropped as oversized.

Rate limiting:

- Server enforces per-connection event-rate caps.
- On overflow, oldest buffered events are dropped first and `obs.drop` audit events are emitted.

## Recommended defaults

- `replayWindowMs`: `300000`
- `serverMaxEventsPerSec`: `50`
- `serverMaxBufferedEvents`: `10000`
- `messageMaxBytes`: `65536`

## Related docs

- [Phase 6 Observability](/phase-6-observability)
- [Gateway Overview](/gateway)
