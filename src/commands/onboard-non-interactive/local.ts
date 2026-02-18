import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { OnboardOptions } from "../onboard-types.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { resolveGatewayPort, writeConfigFile } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../daemon-runtime.js";
import { healthCommand } from "../health.js";
import { applyOnboardingLocalWorkspaceConfig } from "../onboard-config.js";
import {
  applyEnhancedModelStackConfig,
  applyEnhancedMultiAgentConfig,
  applyEnhancedObservabilityConfig,
  applyEnhancedSkillsBundleConfig,
  ensureEnhancedObservabilityDirs,
  initializeEnhancedAgentTemplates,
  runEnhancedFinalVerification,
  validateEnhancedModelStackAuth,
  validateEnhancedObservabilityConfig,
} from "../onboard-enhanced-profile.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  resolveControlUiLinks,
  waitForGatewayReachable,
} from "../onboard-helpers.js";
import { inferAuthChoiceFromFlags } from "./local/auth-choice-inference.js";
import { applyNonInteractiveAuthChoice } from "./local/auth-choice.js";
import { installGatewayDaemonNonInteractive } from "./local/daemon-install.js";
import { applyNonInteractiveGatewayConfig } from "./local/gateway-config.js";
import { logNonInteractiveOnboardingJson } from "./local/output.js";
import { applyNonInteractiveSkillsConfig } from "./local/skills-config.js";
import { resolveNonInteractiveWorkspaceDir } from "./local/workspace.js";

export async function runNonInteractiveOnboardingLocal(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}) {
  const { opts, runtime, baseConfig } = params;
  const mode = "local" as const;
  const profile = opts.profile ?? "standard";

  const workspaceDir = resolveNonInteractiveWorkspaceDir({
    opts,
    baseConfig,
    defaultWorkspaceDir: DEFAULT_WORKSPACE,
  });

  let nextConfig: OpenClawConfig = applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir);

  const inferredAuthChoice = inferAuthChoiceFromFlags(opts);
  if (!opts.authChoice && inferredAuthChoice.matches.length > 1) {
    runtime.error(
      [
        "Multiple API key flags were provided for non-interactive onboarding.",
        "Use a single provider flag or pass --auth-choice explicitly.",
        `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  const authChoice = opts.authChoice ?? inferredAuthChoice.choice ?? "skip";
  const nextConfigAfterAuth = await applyNonInteractiveAuthChoice({
    nextConfig,
    authChoice,
    opts,
    runtime,
    baseConfig,
  });
  if (!nextConfigAfterAuth) {
    return;
  }
  nextConfig = nextConfigAfterAuth;

  const gatewayBasePort = resolveGatewayPort(baseConfig);
  const gatewayResult = applyNonInteractiveGatewayConfig({
    nextConfig,
    opts,
    runtime,
    defaultPort: gatewayBasePort,
  });
  if (!gatewayResult) {
    return;
  }
  nextConfig = gatewayResult.nextConfig;

  nextConfig = applyNonInteractiveSkillsConfig({ nextConfig, opts, runtime });

  if (profile === "enhanced") {
    nextConfig = applyEnhancedModelStackConfig({ cfg: nextConfig });
    const authValidation = validateEnhancedModelStackAuth({ cfg: nextConfig });
    if (authValidation.issues.length > 0 && !opts.skipAuthCheck) {
      runtime.error(
        [
          "Enhanced onboarding auth preflight failed.",
          ...authValidation.issues.map((issue) => `- ${issue.path}: ${issue.message}`),
          "Re-run with provider auth configured, or pass --skip-auth-check to continue.",
        ].join("\n"),
      );
      runtime.exit(1);
      return;
    }
    if (authValidation.issues.length > 0 && opts.skipAuthCheck) {
      runtime.log(
        [
          "Enhanced onboarding: proceeding with --skip-auth-check despite auth issues:",
          ...authValidation.issues.map((issue) => `- ${issue.path}: ${issue.message}`),
        ].join("\n"),
      );
    }
    if (authValidation.warnings.length > 0) {
      runtime.log(
        authValidation.warnings
          .map((warning) => `Enhanced onboarding warning: ${warning.path}: ${warning.message}`)
          .join("\n"),
      );
    }

    nextConfig = applyEnhancedSkillsBundleConfig({
      cfg: nextConfig,
      bundleIds: ["enhancedCore"],
    });
    nextConfig = applyEnhancedMultiAgentConfig({
      cfg: nextConfig,
      workspaceDir,
    });
    nextConfig = applyEnhancedObservabilityConfig({ cfg: nextConfig });
    const obsIssues = validateEnhancedObservabilityConfig(nextConfig);
    if (obsIssues.length > 0) {
      runtime.error(obsIssues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
      runtime.exit(1);
      return;
    }
    await ensureEnhancedObservabilityDirs(nextConfig);
    const verification = await runEnhancedFinalVerification(nextConfig);
    if (!verification.ok) {
      runtime.error(
        [
          "Enhanced onboarding final verification failed.",
          ...verification.issues.map((issue) => `- ${issue.path}: ${issue.message}`),
        ].join("\n"),
      );
      runtime.exit(1);
      return;
    }
    if (verification.warnings.length > 0) {
      runtime.log(
        verification.warnings
          .map((warning) => `Enhanced onboarding warning: ${warning.path}: ${warning.message}`)
          .join("\n"),
      );
    }
  }

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode, profile });
  await writeConfigFile(nextConfig);
  logConfigUpdated(runtime);

  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });
  if (profile === "enhanced") {
    const templateInit = initializeEnhancedAgentTemplates({ cfg: nextConfig });
    if (templateInit.warnings.length > 0) {
      runtime.log(templateInit.warnings.join("\n"));
    }
  }

  await installGatewayDaemonNonInteractive({
    nextConfig,
    opts,
    runtime,
    port: gatewayResult.port,
    gatewayToken: gatewayResult.gatewayToken,
  });

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!opts.skipHealth) {
    const links = resolveControlUiLinks({
      bind: gatewayResult.bind as "auto" | "lan" | "loopback" | "custom" | "tailnet",
      port: gatewayResult.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    await waitForGatewayReachable({
      url: links.wsUrl,
      token: gatewayResult.gatewayToken,
      deadlineMs: 15_000,
    });
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
  }

  logNonInteractiveOnboardingJson({
    opts,
    runtime,
    mode,
    workspaceDir,
    authChoice,
    gateway: {
      port: gatewayResult.port,
      bind: gatewayResult.bind,
      authMode: gatewayResult.authMode,
      tailscaleMode: gatewayResult.tailscaleMode,
    },
    installDaemon: Boolean(opts.installDaemon),
    daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
    skipSkills: Boolean(opts.skipSkills),
    skipHealth: Boolean(opts.skipHealth),
  });

  if (!opts.json) {
    if (profile === "enhanced") {
      runtime.log(
        [
          "Enhanced onboarding next steps:",
          `- ${formatCliCommand("openclaw agents list")}`,
          `- ${formatCliCommand("openclaw models list")}`,
          `- ${formatCliCommand("openclaw status --all")}`,
          `- ${formatCliCommand("openclaw dashboard --no-open")}`,
        ].join("\n"),
      );
    }
    runtime.log(
      `Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`,
    );
  }
}
