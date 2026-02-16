import { randomUUID } from "node:crypto";

export type AuditEvent = {
  timestamp: string;
  traceId: string;
  agentId: string;
  skillId?: string;
  eventType: string;
  decision: "allow" | "deny" | "require_approval" | "executed" | "failed";
  riskTier: "low" | "medium" | "high" | "critical";
  payload: Record<string, unknown>;
};

export function createTraceId(): string {
  return randomUUID();
}
