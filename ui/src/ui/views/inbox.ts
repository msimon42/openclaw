import { html, nothing } from "lit";

type InboxViewMessage = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
};

export type InboxViewProps = {
  loading: boolean;
  error: string | null;
  sessionKey: string | null;
  messages: unknown[];
  workerAgentId: string;
  actionStatus: string | null;
  onRefresh: () => void;
  onPromote: (message: unknown) => void;
  onCallWorker: (message: unknown) => void;
  onWorkerAgentChange: (next: string) => void;
};

function messageText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const message = value as InboxViewMessage;
  const content = message.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
          ? ((entry as { text: string }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function formatTime(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "";
  }
}

export function renderInbox(props: InboxViewProps) {
  return html`
    <section class="grid">
      <div class="card">
        <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
            <div class="card-title">Inbox</div>
          <div class="muted">Session: <code>${props.sessionKey ?? "agent:<id>:inbox"}</code></div>
        </div>
          <div class="row">
          <label>
            Worker
            <input
              type="text"
                style="margin-left: 8px; width: 120px;"
              .value=${props.workerAgentId}
              @input=${(event: Event) =>
                props.onWorkerAgentChange((event.target as HTMLInputElement).value)}
            />
          </label>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>
      ${props.error ? html`<div class="pill danger">${props.error}</div>` : nothing}
      ${props.actionStatus ? html`<div class="pill">${props.actionStatus}</div>` : nothing}
      ${
        props.messages.length === 0
          ? html`<div class="muted">No injected inbox messages.</div>`
          : html`
              <div class="inbox-list">
                ${props.messages.map((message) => {
                  const text = messageText(message);
                  const role =
                    message && typeof message === "object" && typeof (message as { role?: unknown }).role === "string"
                      ? ((message as { role: string }).role ?? "assistant")
                      : "assistant";
                  const timestamp =
                    message && typeof message === "object"
                      ? formatTime((message as { timestamp?: unknown }).timestamp)
                      : "";
                  return html`
                    <article class="inbox-item">
                      <header class="row" style="justify-content: space-between;">
                        <strong>${role}</strong>
                        ${timestamp ? html`<span class="muted">${timestamp}</span>` : nothing}
                      </header>
                      <pre>${text || "(no text content)"}</pre>
                      <div class="toolbar">
                        <button class="btn" @click=${() => props.onPromote(message)}>
                          Promote to work item
                        </button>
                        <button class="btn primary" @click=${() => props.onCallWorker(message)}>
                          Call worker now
                        </button>
                      </div>
                    </article>
                  `;
                })}
              </div>
            `
      }
      </div>
    </section>
  `;
}
