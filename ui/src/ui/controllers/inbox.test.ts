import { describe, expect, it, vi } from "vitest";
import { loadInbox } from "./inbox.ts";

function createState(overrides: Partial<Parameters<typeof loadInbox>[0]> = {}) {
  return {
    client: {
      request: vi.fn(async () => ({})),
    } as unknown as Parameters<typeof loadInbox>[0]["client"],
    connected: true,
    settings: { selectedAgentId: "main", sessionKey: "main" },
    agentsSelectedId: "main",
    inboxLoading: false,
    inboxError: null,
    inboxSessionKey: null,
    inboxMessages: [],
    inboxWorkerAgentId: "worker",
    inboxActionStatus: null,
    inboxLastCallResult: null,
    ...overrides,
  } as Parameters<typeof loadInbox>[0];
}

describe("loadInbox", () => {
  it("loads inbox history from the selected agent inbox session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [{ key: "agent:ops:inbox" }] })
      .mockResolvedValueOnce({
        messages: [{ role: "user", content: "hello from inbox" }],
      });
    const state = createState({
      settings: { selectedAgentId: "ops", sessionKey: "main" },
      agentsSelectedId: "ops",
      client: { request } as unknown as Parameters<typeof loadInbox>[0]["client"],
    });

    await loadInbox(state);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "sessions.list",
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "chat.history",
      expect.objectContaining({ sessionKey: "agent:ops:inbox" }),
    );
    expect(state.inboxSessionKey).toBe("agent:ops:inbox");
    expect(state.inboxMessages).toHaveLength(1);
  });
});
