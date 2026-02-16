---
title: Phase 5 Model Routing
summary: Configure model orchestration, intent routing, fallback behavior, and verification for Phase 5.
---

## What Phase 5 Adds

Phase 5 introduces an intent-aware model router and a hardened fallback runner.

- Route by task intent (`coding`, `everyday`, `x`)
- Deterministic primary + ordered fallback plans
- Automatic retry for transient failures (timeout, 429, 5xx, tool-call parse errors)
- Context-overflow recovery by preferring larger-context fallback models
- Hard stop (no silent retry) on `model_not_allowed` and `invalid_api_key`
- Structured routing diagnostics with fallback hop history

## Required Model Refs

Use these canonical refs in config and allowlists:

- `openai-codex/gpt-5.3-codex`
- `ollama/kimi-k2.5:cloud`
- `ollama/deepseek-v3.2:cloud`
- `xai/grok-3-fast-latest`
- `openrouter/free`

## Config Example

Copy and adapt:

- `config/examples/openclaw.phase5.json`

The router config lives at:

- `agents.defaults.modelRouter`

The allowlist remains:

- `agents.defaults.models`

When `modelRouter` is enabled, all router outputs should also exist in `agents.defaults.models`.

## Provider Auth Setup

Set provider credentials before enabling routing:

1. OpenAI Codex OAuth

```bash
openclaw models auth login --provider openai-codex
```

2. Ollama Cloud (OpenAI-compatible endpoint)

```bash
export OLLAMA_API_KEY="<your-key>"
# Use a provider baseUrl that includes /v1 if you override provider settings.
```

3. xAI

```bash
export XAI_API_KEY="<your-key>"
# xAI OpenAI-compatible base URL:
# https://api.x.ai/v1
```

4. OpenRouter

```bash
export OPENROUTER_API_KEY="<your-key>"
```

## Debugging Router Decisions

Use the CLI flag to print the effective router decision object for a run:

```bash
openclaw agent --local --model-router-debug --message "Implement this TypeScript refactor" --agent main
```

You can also enable router debug globally:

```bash
export OPENCLAW_MODEL_ROUTER_DEBUG=1
```

## Verification Checklist

1. Verify model catalog + auth health

```bash
openclaw models list
openclaw models status --check
```

2. Verify coding route

```bash
openclaw agent --local --model-router-debug --message "Fix build errors and add tests in TypeScript" --agent main
```

Expected primary route: `openai-codex/gpt-5.3-codex`.

3. Verify X route

```bash
openclaw agent --local --model-router-debug --message "Draft a tweet thread about this release for x.com" --agent main
```

Expected primary route: `xai/grok-3-fast-latest`.

4. Verify default route

```bash
openclaw agent --local --model-router-debug --message "Summarize this status update" --agent main
```

Expected primary route: `ollama/kimi-k2.5:cloud`.

5. Verify hard-stop behavior for allowlist errors

Temporarily remove one router model from `agents.defaults.models` and rerun a prompt that selects it.

Expected result: immediate config error, no silent retry to a different model.

6. Verify fallback behavior for transient failures

Temporarily break a provider key for the selected primary model and rerun.

Expected result:

- transient errors (timeouts/429/5xx) retry next fallback
- `invalid_api_key` returns a terminal auth error without fallback

## Router Config Notes

- `agents.defaults.modelRouter.enabled`: enable/disable router
- `agents.defaults.modelRouter.defaultRoute`: fallback route if heuristics do not match
- `agents.defaults.modelRouter.routes.<route>.primary`: route primary model ref
- `agents.defaults.modelRouter.routes.<route>.fallbacks`: ordered fallback refs
- `agents.defaults.modelRouter.disabledProviders`: optional provider denylist
- `OPENCLAW_MODEL_ROUTER=1`: force-enable router from env
