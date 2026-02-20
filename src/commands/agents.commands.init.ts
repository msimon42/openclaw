import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { initAgentWorkspace, listAgentInitTemplates } from "../agents/agent-init.js";
import { requireValidConfig } from "./agents.command-shared.js";

export type AgentsInitOptions = {
  agentId: string;
  template: string;
  workspace?: string;
  force?: boolean;
  json?: boolean;
};

export async function agentsInitCommand(
  opts: AgentsInitOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const template = opts.template?.trim();
  if (!template) {
    runtime.error(`Template is required. Use one of: ${listAgentInitTemplates().join(", ")}`);
    runtime.exit(1);
    return;
  }

  try {
    const result = initAgentWorkspace({
      cfg,
      agentId: opts.agentId,
      template,
      workspaceDir: opts.workspace,
      force: Boolean(opts.force),
    });

    if (opts.json) {
      runtime.log(JSON.stringify(result, null, 2));
      return;
    }

    runtime.log(`Agent workspace initialized: ${result.agentId}`);
    runtime.log(`Template: ${result.template}`);
    runtime.log(`Workspace: ${shortenHomePath(result.workspaceDir)}`);
    runtime.log(`Shared: ${shortenHomePath(result.sharedRoot)}`);
    runtime.log(`Created: ${result.created.length}`);
    if (result.forced.length > 0) {
      runtime.log(`Overwritten (--force): ${result.forced.length}`);
    }
    if (result.skipped.length > 0) {
      runtime.log(`Skipped (already exists): ${result.skipped.length}`);
    }
  } catch (error) {
    runtime.error(String(error));
    runtime.exit(1);
  }
}
