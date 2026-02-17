import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderInbox } from "./inbox.ts";

describe("renderInbox", () => {
  it("renders injected inbox messages with actions", async () => {
    const container = document.createElement("div");
    render(
      renderInbox({
        loading: false,
        error: null,
        sessionKey: "agent:main:inbox",
        messages: [{ role: "user", content: "delegated task payload", timestamp: Date.now() }],
        workerAgentId: "worker",
        actionStatus: null,
        onRefresh: () => undefined,
        onPromote: () => undefined,
        onCallWorker: () => undefined,
        onWorkerAgentChange: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("delegated task payload");
    expect(container.textContent).toContain("Promote to work item");
    expect(container.textContent).toContain("Call worker now");
  });
});

