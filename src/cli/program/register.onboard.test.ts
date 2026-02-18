import { Command } from "commander";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { registerOnboardCommand } from "./register.onboard.js";

const mocks = vi.hoisted(() => ({
  onboardCommand: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("../../commands/onboard.js", () => ({
  onboardCommand: mocks.onboardCommand,
}));

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: async (_runtime: unknown, fn: () => Promise<void>) => {
    await fn();
  },
}));

describe("registerOnboardCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses enhanced onboarding flags", async () => {
    const program = new Command();
    registerOnboardCommand(program);

    await program.parseAsync(
      [
        "onboard",
        "--profile",
        "enhanced",
        "--non-interactive",
        "--skip-auth-check",
        "--force",
        "--accept-risk",
        "--mode",
        "local",
      ],
      { from: "user" },
    );

    expect(mocks.onboardCommand).toHaveBeenCalledTimes(1);
    const [opts] = mocks.onboardCommand.mock.calls[0] ?? [];
    expect(opts).toMatchObject({
      profile: "enhanced",
      nonInteractive: true,
      skipAuthCheck: true,
      forceReset: true,
      acceptRisk: true,
      mode: "local",
    });
  });
});
