import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  decideModelPlan,
  resolveModelRoutingDecision,
  type ModelRouterInput,
} from "./model-router.js";

if (!(globalThis as Record<string, unknown>).File) {
  (globalThis as Record<string, unknown>).File = Blob;
}

function makeConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "ollama/kimi-k2.5:cloud",
          fallbacks: ["ollama/deepseek-v3.2:cloud", "openrouter/free"],
        },
        models: {
          "openai-codex/gpt-5.3-codex": {},
          "ollama/kimi-k2.5:cloud": {},
          "ollama/deepseek-v3.2:cloud": {},
          "xai/grok-3-fast-latest": {},
          "openrouter/free": {},
        },
        modelRouter: {
          enabled: true,
        },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

describe("decideModelPlan", () => {
  it("routes coding prompts to codex with ordered fallbacks", () => {
    const plan = decideModelPlan({
      message: "Please implement the TypeScript refactor and fix CI tests",
      repoContext: "coding",
    });

    expect(plan.route).toBe("coding");
    expect(plan.primary).toEqual({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });
    expect(plan.fallbacks.map((entry) => `${entry.provider}/${entry.model}`)).toEqual([
      "ollama/deepseek-v3.2:cloud",
      "ollama/kimi-k2.5:cloud",
      "openrouter/free",
    ]);
  });

  it("routes X/Twitter prompts to grok", () => {
    const plan = decideModelPlan({
      message: "Draft a tweet thread for x.com about this release",
    });

    expect(plan.route).toBe("x");
    expect(plan.primary).toEqual({
      provider: "xai",
      model: "grok-3-fast-latest",
    });
  });

  it("uses everyday route by default", () => {
    const plan = decideModelPlan({ message: "Summarize this note" });

    expect(plan.route).toBe("everyday");
    expect(plan.primary).toEqual({
      provider: "ollama",
      model: "kimi-k2.5:cloud",
    });
  });

  it("produces a stable effective plan snapshot", () => {
    const scenarios: Record<string, ReturnType<typeof decideModelPlan>> = {
      coding: decideModelPlan({
        message: "Fix build failures and open a PR",
        repoContext: "coding",
      }),
      x: decideModelPlan({
        message: "What is happening on X right now?",
      }),
      everyday: decideModelPlan({
        message: "Create a daily summary for me",
        hasUrls: true,
      }),
    };

    expect(scenarios).toMatchInlineSnapshot(`
      {
        "coding": {
          "fallbacks": [
            {
              "model": "deepseek-v3.2:cloud",
              "provider": "ollama",
            },
            {
              "model": "kimi-k2.5:cloud",
              "provider": "ollama",
            },
            {
              "model": "free",
              "provider": "openrouter",
            },
          ],
          "primary": {
            "model": "gpt-5.3-codex",
            "provider": "openai-codex",
          },
          "rationale": [
            "repo context indicates coding task",
            "matched coding/repo heuristic",
          ],
          "route": "coding",
          "tags": [
            "repo:coding",
            "route:coding",
            "intent:coding",
          ],
        },
        "everyday": {
          "fallbacks": [
            {
              "model": "deepseek-v3.2:cloud",
              "provider": "ollama",
            },
            {
              "model": "free",
              "provider": "openrouter",
            },
          ],
          "primary": {
            "model": "kimi-k2.5:cloud",
            "provider": "ollama",
          },
          "rationale": [
            "default route selected",
          ],
          "route": "everyday",
          "tags": [
            "message:has_urls",
            "route:everyday",
            "intent:default",
          ],
        },
        "x": {
          "fallbacks": [
            {
              "model": "gpt-5.3-codex",
              "provider": "openai-codex",
            },
            {
              "model": "deepseek-v3.2:cloud",
              "provider": "ollama",
            },
            {
              "model": "free",
              "provider": "openrouter",
            },
          ],
          "primary": {
            "model": "grok-3-fast-latest",
            "provider": "xai",
          },
          "rationale": [
            "matched X/Twitter heuristic",
          ],
          "route": "x",
          "tags": [
            "route:x",
            "intent:x-twitter",
          ],
        },
      }
    `);
  });
});

describe("resolveModelRoutingDecision", () => {
  it("skips disabled providers", () => {
    const cfg = makeConfig({
      agents: {
        defaults: {
          model: {
            primary: "ollama/kimi-k2.5:cloud",
          },
          models: {
            "openai-codex/gpt-5.3-codex": {},
            "ollama/kimi-k2.5:cloud": {},
            "ollama/deepseek-v3.2:cloud": {},
            "xai/grok-3-fast-latest": {},
            "openrouter/free": {},
          },
          modelRouter: {
            enabled: true,
            disabledProviders: ["xai"],
          },
        },
      },
    } as OpenClawConfig);

    const decision = resolveModelRoutingDecision({
      cfg,
      input: {
        message: "Draft a tweet thread for x.com",
      },
      provider: "ollama",
      model: "kimi-k2.5:cloud",
    });

    expect(`${decision.provider}/${decision.model}`).toBe("openai-codex/gpt-5.3-codex");
    expect(decision.plan?.rationale.some((entry) => entry.includes("provider disabled"))).toBe(
      true,
    );
  });

  it("skips capability mismatches when required capabilities are set", () => {
    const cfg = makeConfig({
      agents: {
        defaults: {
          model: {
            primary: "ollama/kimi-k2.5:cloud",
          },
          models: {
            "openrouter/free": {},
            "xai/grok-3-fast-latest": {},
          },
          modelRouter: {
            enabled: true,
            routes: {
              everyday: {
                primary: "openrouter/free",
                fallbacks: ["xai/grok-3-fast-latest"],
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    const input: ModelRouterInput = {
      message: "Find social chatter",
      requiredCapabilities: ["social"],
    };
    const decision = resolveModelRoutingDecision({
      cfg,
      input,
      provider: "ollama",
      model: "kimi-k2.5:cloud",
    });

    expect(`${decision.provider}/${decision.model}`).toBe("xai/grok-3-fast-latest");
    expect(decision.plan?.rationale.some((entry) => entry.includes("capability mismatch"))).toBe(
      true,
    );
  });
});
