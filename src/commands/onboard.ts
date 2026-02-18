import type { RuntimeEnv } from "../runtime.js";
import type { OnboardOptions } from "./onboard-types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { isDeprecatedAuthChoice, normalizeLegacyOnboardAuthChoice } from "./auth-choice-legacy.js";
import { DEFAULT_WORKSPACE, handleReset } from "./onboard-helpers.js";
import { runInteractiveOnboarding } from "./onboard-interactive.js";
import { runNonInteractiveOnboarding } from "./onboard-non-interactive.js";

export async function onboardCommand(opts: OnboardOptions, runtime: RuntimeEnv = defaultRuntime) {
  assertSupportedRuntime(runtime);
  const originalAuthChoice = opts.authChoice;
  const normalizedAuthChoice = normalizeLegacyOnboardAuthChoice(originalAuthChoice);
  if (opts.nonInteractive && isDeprecatedAuthChoice(originalAuthChoice)) {
    runtime.error(
      [
        `Auth choice "${String(originalAuthChoice)}" is deprecated.`,
        'Use "--auth-choice token" (Anthropic setup-token) or "--auth-choice openai-codex".',
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  if (originalAuthChoice === "claude-cli") {
    runtime.log('Auth choice "claude-cli" is deprecated; using setup-token flow instead.');
  }
  if (originalAuthChoice === "codex-cli") {
    runtime.log('Auth choice "codex-cli" is deprecated; using OpenAI Codex OAuth instead.');
  }
  const flow = opts.flow === "manual" ? ("advanced" as const) : opts.flow;
  const normalizedOpts =
    normalizedAuthChoice === opts.authChoice && flow === opts.flow
      ? opts
      : { ...opts, authChoice: normalizedAuthChoice, flow };
  const profileRaw =
    typeof normalizedOpts.profile === "string"
      ? normalizedOpts.profile.trim().toLowerCase()
      : undefined;
  if (profileRaw && profileRaw !== "standard" && profileRaw !== "enhanced") {
    runtime.error('Invalid --profile (use "standard" or "enhanced").');
    runtime.exit(1);
    return;
  }
  const finalOpts =
    profileRaw && profileRaw !== normalizedOpts.profile
      ? { ...normalizedOpts, profile: profileRaw as "standard" | "enhanced" }
      : normalizedOpts;

  if (finalOpts.nonInteractive && finalOpts.acceptRisk !== true) {
    runtime.error(
      [
        "Non-interactive onboarding requires explicit risk acknowledgement.",
        "Read: https://docs.openclaw.ai/security",
        `Re-run with: ${formatCliCommand("openclaw onboard --non-interactive --accept-risk ...")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }

  if (finalOpts.reset) {
    if (finalOpts.nonInteractive && !finalOpts.forceReset) {
      runtime.error("Non-interactive reset requires --force.");
      runtime.exit(1);
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    const baseConfig = snapshot.valid ? snapshot.config : {};
    const workspaceDefault =
      finalOpts.workspace ?? baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;
    await handleReset("full", resolveUserPath(workspaceDefault), runtime);
  }

  if (process.platform === "win32") {
    runtime.log(
      [
        "Windows detected — OpenClaw runs great on WSL2!",
        "Native Windows might be trickier.",
        "Quick setup: wsl --install (one command, one reboot)",
        "Guide: https://docs.openclaw.ai/windows",
      ].join("\n"),
    );
  }

  if (finalOpts.nonInteractive) {
    await runNonInteractiveOnboarding(finalOpts, runtime);
    return;
  }

  await runInteractiveOnboarding(finalOpts, runtime);
}

export type { OnboardOptions } from "./onboard-types.js";
