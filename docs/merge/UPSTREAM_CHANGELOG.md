# Upstream Changelog Impact Map

Scope: changelog provided in task prompt.
Legend: Buckets A-F correspond to `docs/merge/FEATURES.md`.

## Changes

- Agents/Anthropic: add opt-in 1M context beta header support for Opus/Sonnet via model params.context1m: true.  
  Subsystems/files: `src/agents/*anthropic*`, `src/agents/model-*`, model params serialization.  
  Overlap: **A (high)**.
- Agents/Models: support Anthropic Sonnet 4.6 with forward-compat fallback to 4.5.  
  Subsystems/files: `src/agents/model-catalog.ts`, `src/agents/model-selection.ts`, aliases/defaults config.  
  Overlap: **A (high)**.
- Commands/Subagents: add `/subagents spawn`.  
  Subsystems/files: `src/agents/openclaw-tools.ts`, slash-command parsing, docs/tools/subagents.  
  Overlap: **B (high)**.
- Agents/Subagents: sessions_spawn accepted-response note for polling disabled on one-off calls.  
  Subsystems/files: `src/agents/openclaw-tools.subagents*`, prompt/runtime notes.  
  Overlap: **B (high)**.
- Agents/Subagents: prefix spawned subagent task messages with source context.  
  Subsystems/files: `src/agents/openclaw-tools.subagents*`, event payload shaping.  
  Overlap: **B (high)**.
- iOS/Share extension forwarding shared URL/text/image to gateway.  
  Subsystems/files: `apps/ios/**`, gateway request APIs.  
  Overlap: D (medium).
- iOS/Talk background listening toggle.  
  Subsystems/files: `apps/ios/Sources/Voice/*`.  
  Overlap: none.
- iOS/Talk voice directive hint toggle.  
  Subsystems/files: iOS Talk prompt/settings paths.  
  Overlap: none.
- iOS/Talk barge-in hardening.  
  Subsystems/files: iOS talk audio routing logic.  
  Overlap: none.
- Slack native single-message text streaming + reply threading alignment.  
  Subsystems/files: `src/slack/streaming.ts`, `src/slack/send.ts`, dispatch/replies.  
  Overlap: **C/F (high regression risk for streaming/threading)**.
- Slack configurable streaming modes for draft previews.  
  Subsystems/files: `src/slack/draft-stream.ts`, stream config parsing.  
  Overlap: C/F (medium).
- Telegram message tool inline button style support.  
  Subsystems/files: `src/telegram/*`, message tool schema, parsing/send pipeline.  
  Overlap: F (medium).
- Telegram user message reactions as system events.  
  Subsystems/files: `src/telegram/*` monitor/events.  
  Overlap: F (low).
- iMessage replyToId support and tag normalization.  
  Subsystems/files: `src/imessage/send.ts`, outbound normalization.  
  Overlap: C/F (medium).
- Tool Display/Web UI intent-first tool details + exec summaries.  
  Subsystems/files: `ui/src/ui/tool-display.ts`, app render paths.  
  Overlap: **C (high)**.
- Discord /exec options exposed (host/security/ask/node).  
  Subsystems/files: discord command schema and slash handlers.  
  Overlap: F (low).
- Discord reusable interactive components.  
  Subsystems/files: discord components handling.  
  Overlap: F (low).
- Discord per-button allowedUsers allowlist.  
  Subsystems/files: discord interaction gate checks.  
  Overlap: F (medium security).
- Cron/Gateway webhook delivery separation + URL validation + legacy fallback.  
  Subsystems/files: cron job schema/runtime + gateway delivery handling.  
  Overlap: E/F (medium).
- Cron/CLI stagger defaults + migration + `--stagger`/`--exact`.  
  Subsystems/files: cron CLI and persistence/migration.  
  Overlap: E (medium).
- Cron usage telemetry + local report script.  
  Subsystems/files: cron runtime logs/webhooks, scripts usage report.  
  Overlap: E/C (medium).
- Tools/Web URL allowlists for web_search/web_fetch.  
  Subsystems/files: web tool implementation + config validation + errors.  
  Overlap: **F (high)**.
- Browser extraArgs config for Chrome launch.  
  Subsystems/files: browser tool/config.  
  Overlap: F (low).
- Voice Call pre-cache inbound greeting TTS.  
  Subsystems/files: extension voice-call runtime/timers.  
  Overlap: none.
- Skills compact `~` path rendering in prompt.  
  Subsystems/files: skills prompt serialization.  
  Overlap: none.
- Skills routing-boundary guidance refinements.  
  Subsystems/files: skills docs/prompts.  
  Overlap: none.
- Auto-reply/prompts include trusted inbound `message_id`.  
  Subsystems/files: inbound metadata payload formatting.  
  Overlap: F (medium).
- Auto-reply include trusted inbound `sender_id`.  
  Subsystems/files: moderation metadata payload.  
  Overlap: F (medium).
- UI/Sessions avoid duplicate typed prefixes in names.  
  Subsystems/files: session label rendering in UI.  
  Overlap: C (low).
- Agents/Z.AI enable `tool_stream` by default with opt-out.  
  Subsystems/files: provider params defaults.  
  Overlap: A/C (low).
- Plugins before_agent_start model/provider overrides before resolution.  
  Subsystems/files: plugin hook runner and model resolution path.  
  Overlap: A/F (medium).
- Mattermost reaction actions + notifications with remove boolean.  
  Subsystems/files: extension mattermost channel + reactions.  
  Overlap: low.
- Memory/Search FTS fallback + query expansion.  
  Subsystems/files: `src/memory/*search*`.  
  Overlap: low.
- Agents/Models per-model thinkingDefault overrides.  
  Subsystems/files: model config + model resolution/run defaults.  
  Overlap: **A/B (high)**.
- Agents enable llms.txt discovery by default.  
  Subsystems/files: link-understanding defaults/discovery runner.  
  Overlap: low.
- Extensions/Auth OpenAI Codex CLI auth provider.  
  Subsystems/files: extension auth providers.  
  Overlap: low.
- Feishu Bitable create-app/create-field tools.  
  Subsystems/files: extension feishu tool defs.  
  Overlap: low.
- Docker optional browser preinstall build arg.  
  Subsystems/files: Dockerfile/install scripts.  
  Overlap: low.

## Fixes

- Agents/Image resize diagnostics collapsed + size details.  
  Subsystems/files: image preprocessing/logging.  
  Overlap: low.
- Agents/Subagents pre-call context guarding with truncation/compaction markers.  
  Subsystems/files: `src/agents/openclaw-tools.subagents*`, context guard/compaction.  
  Overlap: **B (high)**.
- Agents/Subagents guidance for `[compacted:]` / `[truncated:]` markers.  
  Subsystems/files: subagent prompts/system guidance.  
  Overlap: **B/C (high)**.
- Agents/Tools read auto-paging + model-contextWindow scaling.  
  Subsystems/files: tool read implementation/context budgets.  
  Overlap: B/F (medium).
- Agents/Tools dedupe read truncation payloads + heavier metadata guard.  
  Subsystems/files: compaction guard + tool result metadata accounting.  
  Overlap: **B (high)**.
- Reply threading sticky context across streamed/split chunks incl iMessage/Telegram/Discord/Matrix.  
  Subsystems/files: `src/infra/outbound/*`, channel sends.  
  Overlap: **C/F (high)**.
- Gateway/Agent transient lifecycle error defer window for `agent.wait`.  
  Subsystems/files: gateway agent lifecycle/wait logic.  
  Overlap: C (medium).
- Hooks/Automation lifecycle events bridge with session-key correlation.  
  Subsystems/files: hooks/internal events + outbound/inbound pipeline.  
  Overlap: E/F (medium).
- Media understanding honors `agents.defaults.imageModel` fallback.  
  Subsystems/files: media-understanding runner/provider selection.  
  Overlap: A (low).
- iOS/Onboarding auth retry-loop stabilization.  
  Subsystems/files: `apps/ios/Sources/Onboarding/*`, gateway issue state.  
  Overlap: **D (high)**.
- Voice-call auto-end on media disconnect.  
  Subsystems/files: voice-call manager/events.  
  Overlap: low.
- Voice call/Gateway turn locking + transcript dedupe + latency hardening.  
  Subsystems/files: voice-call runtime/gateway stats.  
  Overlap: low.
- iOS/Chat routes RPCs via operator session.  
  Subsystems/files: iOS Chat transport/session selection.  
  Overlap: D (medium).
- macOS Sparkle appcast correction.  
  Subsystems/files: appcast/version metadata.  
  Overlap: low.
- Gateway/Auth clears stale device-auth tokens on mismatch.  
  Subsystems/files: gateway auth token store/validation.  
  Overlap: D/F (medium).
- Telegram DM voice-note transcription fallback.  
  Subsystems/files: telegram media/transcription path.  
  Overlap: low.
- Telegram polls wiring restored.  
  Subsystems/files: telegram handlers/actions.  
  Overlap: low.
- WebChat strips reply/audio directive tags.  
  Subsystems/files: webchat render normalization.  
  Overlap: C (low).
- Discord honors configured HTTP proxy for allowlist/app-id REST.  
  Subsystems/files: discord REST clients/proxy config.  
  Overlap: F (low).
- BlueBubbles message_id fallback recovery improvements.  
  Subsystems/files: extension bluebubbles send/monitor mapping.  
  Overlap: low.
- Security/Exec OC-09 env-var injection fix.  
  Subsystems/files: exec tool sandbox/validation.  
  Overlap: **F (critical)**.
- Security/Config include confinement + traversal/symlink hardening + doctor hints.  
  Subsystems/files: config loader, doctor config flow.  
  Overlap: **F (critical)**.
- Providers local ollama/vllm unconfigured error clarity.  
  Subsystems/files: provider error messages.  
  Overlap: low.
- TTS aggregated failures show all provider errors.  
  Subsystems/files: tts core aggregation.  
  Overlap: low.
- CLI/Doctor/Configure loopback-only auth check skip.  
  Subsystems/files: doctor/configure auth checks.  
  Overlap: **D/F (high)**.
- CLI/Doctor gateway service-token drift reconcile post re-pair.  
  Subsystems/files: doctor gateway checks/repair.  
  Overlap: **D/F (high)**.
- Process/Windows detached spawn fix.  
  Subsystems/files: process exec/spawn utils.  
  Overlap: low.
- Process SIGTERM then SIGKILL tree termination.  
  Subsystems/files: `src/process/kill-tree.ts`.  
  Overlap: low.
- Sessions/Windows atomic session-store writes.  
  Subsystems/files: sessions store persistence.  
  Overlap: low.
- Agents/Image base64 payload validation.  
  Subsystems/files: image sanitization/submit path.  
  Overlap: low.
- Models CLI catalog entry validation in `models set`.  
  Subsystems/files: `src/commands/models/set.ts`, model config validation.  
  Overlap: A (medium).
- Usage last-turn totals isolation.  
  Subsystems/files: usage reporting pipeline/UI.  
  Overlap: C (low).
- Cron accountId resolve from agent bindings.  
  Subsystems/files: cron run binding resolution.  
  Overlap: E (medium).
- Gateway/HTTP unbracketed IPv6 Host preservation.  
  Subsystems/files: gateway HTTP normalization.  
  Overlap: low.
- Sandbox workspace orphaning fix in SHA migration.  
  Subsystems/files: sandbox/workspace slug migration.  
  Overlap: F (medium).
- Ollama/Qwen reasoning field format support.  
  Subsystems/files: ollama stream parsing.  
  Overlap: A (low).
- OpenAI/Transcripts orphaned reasoning block drop in repair.  
  Subsystems/files: transcript repair logic.  
  Overlap: C (low).
- Test typing fixes + repo-wide typecheck.  
  Subsystems/files: tests/types cross-repo.  
  Overlap: C/E/F (low).
- Gateway/Channels health check validation + restart hardening.  
  Subsystems/files: gateway channels health/restart logic and config validation.  
  Overlap: E/F (medium).
- Gateway/WebChat chat.history payload hard-cap/truncation.  
  Subsystems/files: webchat history API and truncation.  
  Overlap: C (medium).
- UI/Usage `--text-muted` -> `--muted` style fix.  
  Subsystems/files: usage styles.  
  Overlap: C (low).
- UI/Usage preserve selected-range totals under downsampling.  
  Subsystems/files: usage charts/aggregation.  
  Overlap: C (low).
- UI/Sessions refresh after successful delete and preserve errors.  
  Subsystems/files: UI sessions controller/view.  
  Overlap: C (low).
- Scripts/UI/Windows pnpm ui:* spawn EINVAL and shell safety.  
  Subsystems/files: `scripts/ui.js`.  
  Overlap: low.
- Hooks/Session-memory /new summary recovery with reset transcripts.  
  Subsystems/files: session-memory hook fallback extraction.  
  Overlap: low.
- Auto-reply/Sessions stale thread ID leakage prevention.  
  Subsystems/files: auto-reply thread/session mapping.  
  Overlap: C/F (medium).
- Slack forwarded-attachment ingestion restriction.  
  Subsystems/files: slack monitor media ingestion.  
  Overlap: **F (high)**.
- Feishu mention detection in post messages with embedded docs.  
  Subsystems/files: feishu monitor mention parser.  
  Overlap: low.
- Agents/Sessions lock watchdog hold-window alignment.  
  Subsystems/files: session lock maintenance/run budgets.  
  Overlap: B/C (medium).
- Cron default model fallback preservation on primary override.  
  Subsystems/files: cron model merge semantics.  
  Overlap: E/A (medium).
- Cron text-only announce routing via main session flow.  
  Subsystems/files: cron announce flow + subagent announce integration.  
  Overlap: E/B (medium).
- Cron timeoutSeconds:0 as no-timeout.  
  Subsystems/files: cron timeout handling.  
  Overlap: E (low).
- Cron announce injection targets delivery-config session.  
  Subsystems/files: cron delivery routing.  
  Overlap: E (medium).
- Cron/Heartbeat sessionKey canonicalization and flat sessionKey preserve.  
  Subsystems/files: heartbeat enqueue/wake routing + cron session mapping.  
  Overlap: E (medium).
- Cron/Webhooks reuse fresh session IDs for stable session keys.  
  Subsystems/files: cron/webhook session assignment.  
  Overlap: E (medium).
- Cron spin-loop prevention for same-second completion.  
  Subsystems/files: cron scheduler next-run calc.  
  Overlap: E (low).
- OpenClawKit/iOS ChatUI canonical session-key completion events + message-id preserve.  
  Subsystems/files: shared iOS ChatUI state/history refresh.  
  Overlap: D/C (medium).
- iOS/Onboarding QR-first wizard + setup-code deep links + guidance.  
  Subsystems/files: iOS onboarding wizard, QR, pairing.  
  Overlap: **D (high)**.
- iOS/Gateway connect/discovery stabilization + onboarding reset recovery.  
  Subsystems/files: iOS gateway controller/state.  
  Overlap: D (medium).
- iOS/Talk key handling/accessibility/ATS tightening.  
  Subsystems/files: iOS Talk config/status UI/network entitlements.  
  Overlap: none.
- iOS/Location monitor restoration.  
  Subsystems/files: iOS location service/ATS keys.  
  Overlap: none.
- iOS/Signing local team auto-select and overrides.  
  Subsystems/files: iOS build scripts/project generation.  
  Overlap: none.
- Discord/Telegram per-account message action gates correctness.  
  Subsystems/files: channel action auth gate resolution.  
  Overlap: F (medium).
- Telegram DM-topic draft/thread reply preservation.  
  Subsystems/files: telegram thread id handling in dispatch/send.  
  Overlap: C/F (medium).
- Telegram private-chat topic thread ID outbound + retries/errors.  
  Subsystems/files: telegram send routing/retry.  
  Overlap: C/F (medium).
- Discord duplicate media delivery prevention with message tool media.  
  Subsystems/files: discord outbound result media handling.  
  Overlap: C/F (medium).
- Discord audioAsVoice auto-replies through voice API.  
  Subsystems/files: discord auto-reply media path.  
  Overlap: low.
- Discord thread creation skip in invalid channel types + group metadata freshness.  
  Subsystems/files: discord channel thread routing metadata.  
  Overlap: C/F (low).
- Discord/Commands allowFrom normalization for prefixes/mentions.  
  Subsystems/files: command auth normalization.  
  Overlap: F (medium).
- Telegram draft-stream preview reply attachment in `replyToMode: all`.  
  Subsystems/files: telegram draft stream/reply context.  
  Overlap: **C/F (high)**.
- Telegram final reply overwrite prevention + suppress false tool-error warnings.  
  Subsystems/files: telegram stream finalization/error handling.  
  Overlap: **C/F (high)**.
- Telegram first preview debounce + short-response finalization edit.  
  Subsystems/files: telegram draft streaming UX logic.  
  Overlap: C (medium).
- Telegram disable block streaming when streamMode off.  
  Subsystems/files: telegram chunking/stream mode gating.  
  Overlap: C/F (medium).
- Telegram partial stream single-message behavior across boundaries.  
  Subsystems/files: telegram draft stream state machine.  
  Overlap: C/F (medium).
- Telegram native command name normalization and logging on sync failures.  
  Subsystems/files: telegram command menu registration.  
  Overlap: low.
- Telegram non-abort slash commands on normal chat lane; abort on control lane.  
  Subsystems/files: telegram lane routing/concurrency.  
  Overlap: C/F (medium).
- Telegram ignore `<media:...>` placeholders for MEDIA path extraction.  
  Subsystems/files: telegram media extraction parser.  
  Overlap: low.
- Telegram skip retries on 20MB getFile failures and continue text processing.  
  Subsystems/files: telegram media download fallback.  
  Overlap: low.
- Telegram clear polling offsets on token/account changes.  
  Subsystems/files: telegram polling offset store.  
  Overlap: low.
- Telegram autoSelectFamily default on Node 22+.  
  Subsystems/files: telegram network config.  
  Overlap: low.
- Auto-reply/TTS keep tool-result media delivery in groups/native command sessions.  
  Subsystems/files: auto-reply tool-result media suppression rules.  
  Overlap: C/F (medium).
- Agents/Tools deliver tool-result media even with verbose output off.  
  Subsystems/files: tool result media delivery gating.  
  Overlap: C/F (medium).
- Discord reaction notification handling optimization.  
  Subsystems/files: discord reaction routing/fetch behavior.  
  Overlap: low.
- CLI/Pairing `qr --remote` prefers gateway.remote.url and alias path.  
  Subsystems/files: cli qr pairing URL resolution.  
  Overlap: D/E (low).
- CLI/QR fail-fast validation when remote URL not configured.  
  Subsystems/files: qr CLI validation path.  
  Overlap: D/E (low).
- CLI parent/subcommand option collision fixes.  
  Subsystems/files: CLI command parser wiring.  
  Overlap: E/F (medium).
- CLI/Doctor non-interactive `--fix --yes` exit promptness.  
  Subsystems/files: doctor command completion/exit path.  
  Overlap: F (medium).
- CLI/Doctor dmPolicy open wildcard auto-repair channel-correct paths.  
  Subsystems/files: doctor repair routines/config write paths.  
  Overlap: **F (high)**.
- CLI/Doctor service-token drift detection with env token source.  
  Subsystems/files: doctor gateway token drift checks.  
  Overlap: F (medium).
- Gateway/Update avoid restart loops on failed updates + run doctor --fix.  
  Subsystems/files: update runner/startup/restart flow.  
  Overlap: E/F (medium).
- Gateway/Update preserve restart delivery context.  
  Subsystems/files: update-run response routing context.  
  Overlap: E (medium).
- CLI/Update standalone restart helper status reporting.  
  Subsystems/files: cli update command/restart helper.  
  Overlap: E (low).
- CLI/Daemon stale service-token warning semantics.  
  Subsystems/files: daemon restart/install flows.  
  Overlap: E/F (low).
- CLI/Daemon prefer active version-manager Node + PATH fixes.  
  Subsystems/files: daemon install helpers/service env path.  
  Overlap: E (low).
- CLI/Status `--all` token summary fix for bot-token-only channels.  
  Subsystems/files: status-all channel summaries.  
  Overlap: E (low).
- CLI/Configure searchable model picker tokenized matching.  
  Subsystems/files: configure model-picker prompt select UI.  
  Overlap: A/D (low).
- CLI/Message preserve `--components` JSON payloads.  
  Subsystems/files: message command argument parsing.  
  Overlap: low.
- Voice Call stale call reaper option.  
  Subsystems/files: voice-call manager timers/config.  
  Overlap: low.
- Auto-reply/Subagents propagate group context when spawned via `/subagents spawn`.  
  Subsystems/files: subagent spawn context propagation.  
  Overlap: **B (high)**.
- Subagents nested announce results routed back to parent session after parent run end.  
  Subsystems/files: subagent announce queue/routing fallback.  
  Overlap: **B (high)**.
- Subagents capped announce retries with expiry.  
  Subsystems/files: subagent deferred announce retry loop.  
  Overlap: B (medium).
- Agents/Tools/exec preflight guard against shell env-var injection patterns.  
  Subsystems/files: exec tool preflight detection.  
  Overlap: **F (high)**.
- Agents/Tools/exec non-zero exit code treated as completed with exit code appended.  
  Subsystems/files: exec tool result/error classification.  
  Overlap: F (medium).
- Agents/Tools loop detection improvements + diagnostic events.  
  Subsystems/files: tool loop detector/state/diagnostics.  
  Overlap: B/F (medium).
- Agents/Hooks preserve before_tool_call wrapped-marker through abort-signal wrapping.  
  Subsystems/files: hook wrapping for tool calls.  
  Overlap: F (medium).
- Agents/Tests before_message_write persistence regression coverage.  
  Subsystems/files: agent persistence tests/hook coverage.  
  Overlap: low.
- Agents/Tools scope message tool schema to active channel.  
  Subsystems/files: message tool schema/channel-specific adapters.  
  Overlap: C/F (medium).
- Agents/Image tool schema replaces Anthropic-incompatible union schema.  
  Subsystems/files: image tool schema/types.  
  Overlap: F (medium).
- Agents/Models auth-profile cooldown near-expiry probe of primary model.  
  Subsystems/files: model auth/failover probing.  
  Overlap: A (medium).
- Agents/Failover classify provider abort stop-reason as timeout-class fallback-triggering.  
  Subsystems/files: failover error classification.  
  Overlap: A (medium).
- Models/CLI auth-profile credentials sync into auth.json before registry checks.  
  Subsystems/files: models list/status auth sync.  
  Overlap: A/E (low).
- Agents/Context bootstrap cap increase + truncation visibility markers.  
  Subsystems/files: context bootstrap/`/context` reporting.  
  Overlap: B/C (medium).
- Memory/QMD managed collection scoping per agent + precreate directories.  
  Subsystems/files: qmd manager/collection registration.  
  Overlap: low.
- Cron post-run maintenance recompute schedule-error isolation.  
  Subsystems/files: cron persistence maintenance.  
  Overlap: E (low).
- Gateway/Config patch object-array merge behavior fix for missing id entries.  
  Subsystems/files: config patch merge logic.  
  Overlap: D/F (medium).
- Gateway/Auth trusted proxy whitespace trim.  
  Subsystems/files: auth trusted-proxy matcher.  
  Overlap: F (low).
- Config/Discord require string IDs in allowlists + doctor repair.  
  Subsystems/files: discord config schema + doctor repair.  
  Overlap: F (medium).
- Security/Sessions transcript file mode 0600 + audit fix remediation.  
  Subsystems/files: session transcript creation/security audit fix.  
  Overlap: **F (high)**.
- Sessions/Maintenance archive on prune + subdir media cleanup + purge deleted archives.  
  Subsystems/files: session maintenance cleanup tasks.  
  Overlap: C/F (low).
- Infra/Fetch abort-signal listener cleanup reliability.  
  Subsystems/files: `src/infra/fetch.ts`.  
  Overlap: F (low).
- Heartbeat suppressible tool error warnings via config flag.  
  Subsystems/files: heartbeat runner warning emission.  
  Overlap: E (low).
- Heartbeat sender metadata in prompts.  
  Subsystems/files: heartbeat prompt composition.  
  Overlap: E (low).
- Heartbeat/Telegram responsePrefix stripping before ack detection.  
  Subsystems/files: telegram heartbeat ack parse.  
  Overlap: E/C (low).

## Highest-Risk Overlap Rollup

- A: model params (`context1m`, `thinkingDefault`), Sonnet 4.6 forward-compat, fallback semantics.
- B: `/subagents spawn`, sessions_spawn responses, source-prefixing, context compaction/truncation markers.
- C: streamed delivery/threading behavior, tool-display/session UI merges, observability stream/view integration.
- D: onboarding/iOS pairing/auth retry logic and gateway-driven onboarding flows.
- E: doctor/update/cron behavior where enhanced ops commands depend on consistent schema and routing.
- F: security hardening (exec env injection, config include confinement, session transcript perms, web allowlists).
