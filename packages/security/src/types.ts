export type Capability =
  | "shell.exec"
  | "network.fetch"
  | "filesystem.read"
  | "filesystem.write"
  | "tool.invoke"
  | "model.invoke"
  | "plugin.load";

export type RiskTier = "low" | "medium" | "high" | "critical";

export type PolicyLayer = {
  allow?: Capability[];
  deny?: Capability[];
  allowDomains?: string[];
  writePaths?: string[];
  requireApproval?: boolean;
};

export type EffectivePolicy = {
  allow: Set<Capability>;
  deny: Set<Capability>;
  allowDomains: string[];
  writePaths: string[];
  requireApproval: boolean;
};
