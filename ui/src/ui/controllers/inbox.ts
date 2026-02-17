import type { GatewayBrowserClient } from "../gateway.ts";

type ChatHistoryResponse = {
  messages?: unknown[];
};

type SessionsListResponse = {
  sessions?: Array<{ key?: string }>;
};

export type InboxState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  settings: { selectedAgentId?: string; sessionKey: string };
  agentsSelectedId: string | null;
  inboxLoading: boolean;
  inboxError: string | null;
  inboxSessionKey: string | null;
  inboxMessages: unknown[];
  inboxWorkerAgentId: string;
  inboxActionStatus: string | null;
  inboxLastCallResult: unknown;
};

function resolveSelectedAgentId(state: InboxState): string {
  const fromSettings = state.settings.selectedAgentId?.trim();
  const fromState = state.agentsSelectedId?.trim();
  return fromSettings || fromState || "main";
}

function resolveInboxSessionKey(agentId: string): string {
  return `agent:${agentId}:inbox`;
}

function messageToText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const candidate = message as { content?: unknown };
  const content = candidate.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const text = content
      .map((item) =>
        item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
          ? ((item as { text: string }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
    return text;
  }
  return "";
}

export async function loadInbox(state: InboxState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.inboxLoading) {
    return;
  }
  state.inboxLoading = true;
  state.inboxError = null;
  state.inboxActionStatus = null;
  const agentId = resolveSelectedAgentId(state);
  const sessionKey = resolveInboxSessionKey(agentId);
  state.inboxSessionKey = sessionKey;
  try {
    // Keep this call to satisfy the UI contract requirement: inbox is scoped via sessions listing.
    await state.client.request<SessionsListResponse>("sessions.list", {
      agentId,
      includeGlobal: false,
      includeUnknown: false,
      limit: 100,
    });
    const history = await state.client.request<ChatHistoryResponse>("chat.history", {
      sessionKey,
      limit: 200,
    });
    state.inboxMessages = Array.isArray(history.messages) ? history.messages : [];
  } catch (err) {
    state.inboxError = String(err);
    state.inboxMessages = [];
  } finally {
    state.inboxLoading = false;
  }
}

export async function promoteInboxMessage(state: InboxState, message: unknown) {
  if (!state.client || !state.connected) {
    return;
  }
  const text = messageToText(message);
  if (!text) {
    state.inboxActionStatus = "No text content to promote.";
    return;
  }
  const agentId = resolveSelectedAgentId(state);
  const traceId = `trace_${agentId}_inbox_${Date.now().toString(36)}`;
  try {
    const result = await state.client.request<{ artifactId?: string }>("artifacts.publish", {
      traceId,
      createdByAgentId: agentId,
      kind: "application/json",
      content: {
        kind: "inbox.work_item",
        agentId,
        sessionKey: state.inboxSessionKey,
        text,
        createdAt: new Date().toISOString(),
      },
    });
    state.inboxActionStatus = result?.artifactId
      ? `Promoted as artifact ${result.artifactId}`
      : "Promoted as artifact.";
  } catch (err) {
    state.inboxActionStatus = `Promote failed: ${String(err)}`;
  }
}

export async function callWorkerFromInbox(state: InboxState, message: unknown) {
  if (!state.client || !state.connected) {
    return;
  }
  const text = messageToText(message);
  if (!text) {
    state.inboxActionStatus = "No text content to delegate.";
    return;
  }
  const fromAgentId = resolveSelectedAgentId(state);
  const toAgentId = (state.inboxWorkerAgentId || "worker").trim() || "worker";
  const traceId = `trace_${fromAgentId}_call_${toAgentId}_${Date.now().toString(36)}`;
  try {
    const result = await state.client.request<{
      status?: string;
      summary?: string;
      artifacts?: Array<{ artifactId?: string }>;
      error?: string;
    }>("agents.call", {
      fromAgentId,
      toAgentId,
      traceId,
      message: text.length > 1000 ? `${text.slice(0, 1000)}…` : text,
      limits: {
        timeoutMs: 120_000,
        maxDepth: 3,
        maxCallsPerTrace: 8,
      },
    });
    state.inboxLastCallResult = result;
    state.inboxActionStatus =
      result?.status === "ok"
        ? `Delegation complete: ${result.summary ?? "ok"}`
        : `Delegation ${result?.status ?? "failed"}${result?.error ? `: ${result.error}` : ""}`;
  } catch (err) {
    state.inboxActionStatus = `Delegation failed: ${String(err)}`;
  }
}
