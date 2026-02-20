import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

vi.mock("./pi-embedded-helpers.js", () => ({
  isLikelyContextOverflowError: (message?: string) =>
    typeof message === "string" && /context length exceeded/i.test(message),
  classifyFailoverReason: () => null,
}));

const { __resetModelFallbackCircuitForTests, runWithModelFallback } =
  await import("./model-fallback.js");

function makeCfg(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["anthropic/claude-haiku-3-5"],
        },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

describe("runWithModelFallback phase 5", () => {
  beforeEach(() => {
    __resetModelFallbackCircuitForTests();
  });

  it("retries on provider 5xx errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("provider down"), { status: 503 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["openai", "gpt-4.1-mini"],
      ["anthropic", "claude-haiku-3-5"],
    ]);
  });

  it("does not retry invalid_api_key errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("invalid_api_key"), { status: 401 }))
      .mockResolvedValueOnce("unexpected");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow(/authentication failed/i);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not retry model_not_allowed errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("model_not_allowed: not in allowlist"))
      .mockResolvedValueOnce("unexpected");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow(/allowlist/i);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("switches to larger-context fallback on context overflow", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/model-small",
            fallbacks: ["openai/model-large"],
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.com/v1",
            models: [
              {
                id: "model-small",
                name: "small",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8000,
                maxTokens: 2048,
              },
              {
                id: "model-large",
                name: "large",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("context length exceeded"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "model-small",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["openai", "model-small"],
      ["openai", "model-large"],
    ]);
  });
});
