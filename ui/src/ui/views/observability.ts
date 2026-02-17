import { html } from "lit";
import type {
  ObsEventRecord,
  ObsHealthPayload,
} from "../../../../src/observability/stream-protocol.js";
import type {
  AuditFilterState,
  DerivedSpend,
  SpendWindow,
} from "../../services/observability-store.ts";
import type { ObservabilityStreamStatus } from "../../services/observability-stream.ts";

export type ObservabilityViewProps = {
  connected: boolean;
  status: ObservabilityStreamStatus;
  section: "audit" | "spend" | "health";
  onSectionChange: (next: "audit" | "spend" | "health") => void;
  filter: AuditFilterState;
  onFilterChange: (next: AuditFilterState) => void;
  availableAgents: string[];
  availableEventTypes: string[];
  availableModelRefs: string[];
  availableRiskTiers: string[];
  events: ObsEventRecord[];
  selectedEventId: string | null;
  onSelectEvent: (eventId: string) => void;
  traceEvents: ObsEventRecord[];
  spendWindow: SpendWindow;
  onSpendWindowChange: (next: SpendWindow) => void;
  derivedSpend: DerivedSpend;
  fallbackCounts: Array<{ fromModelRef: string; toModelRef: string; count: number }>;
  healthSummary: ObsHealthPayload | null;
};

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString();
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "0";
}

function renderAudit(props: ObservabilityViewProps) {
  const selected = props.events.find((entry) => entry.eventId === props.selectedEventId) ?? null;
  return html`
    <section class="card">
      <div class="card-title">Live Audit</div>
      <div class="card-sub">Streaming audit events with trace grouping and server-side replay.</div>
      <div class="form-grid" style="margin-top: 12px; grid-template-columns: repeat(3, minmax(0, 1fr));">
        <label class="field">
          <span>Agent</span>
          <select
            .value=${props.filter.agentId ?? ""}
            @change=${(event: Event) =>
              props.onFilterChange({
                ...props.filter,
                agentId: (event.target as HTMLSelectElement).value || undefined,
              })}
          >
            <option value="">All</option>
            ${props.availableAgents.map((agentId) => html`<option .value=${agentId}>${agentId}</option> `)}
          </select>
        </label>
        <label class="field">
          <span>Event type</span>
          <select
            .value=${props.filter.eventType ?? ""}
            @change=${(event: Event) =>
              props.onFilterChange({
                ...props.filter,
                eventType: (event.target as HTMLSelectElement).value || undefined,
              })}
          >
            <option value="">All</option>
            ${props.availableEventTypes.map((eventType) => html`<option .value=${eventType}>${eventType}</option> `)}
          </select>
        </label>
        <label class="field">
          <span>Decision</span>
          <select
            .value=${props.filter.decisionOutcome ?? ""}
            @change=${(event: Event) =>
              props.onFilterChange({
                ...props.filter,
                decisionOutcome:
                  ((event.target as HTMLSelectElement).value as "allow" | "deny") || undefined,
              })}
          >
            <option value="">All</option>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
        </label>
        <label class="field">
          <span>Model ref</span>
          <select
            .value=${props.filter.modelRef ?? ""}
            @change=${(event: Event) =>
              props.onFilterChange({
                ...props.filter,
                modelRef: (event.target as HTMLSelectElement).value || undefined,
              })}
          >
            <option value="">All</option>
            ${props.availableModelRefs.map((modelRef) => html`<option .value=${modelRef}>${modelRef}</option> `)}
          </select>
        </label>
        <label class="field">
          <span>Risk tier</span>
          <select
            .value=${props.filter.riskTier ?? ""}
            @change=${(event: Event) =>
              props.onFilterChange({
                ...props.filter,
                riskTier: (event.target as HTMLSelectElement).value || undefined,
              })}
          >
            <option value="">All</option>
            ${props.availableRiskTiers.map((riskTier) => html`<option .value=${riskTier}>${riskTier}</option> `)}
          </select>
        </label>
        <label class="field">
          <span>Search</span>
          <input
            .value=${props.filter.query ?? ""}
            @input=${(event: Event) =>
              props.onFilterChange({
                ...props.filter,
                query: (event.target as HTMLInputElement).value || undefined,
              })}
            placeholder="eventType, model.ref, tool.name, traceId"
          />
        </label>
      </div>
      <div class="grid grid-cols-2" style="margin-top: 12px; gap: 12px; align-items: start;">
        <div class="list" style="max-height: 420px; overflow: auto;">
          ${
            props.events.length === 0
              ? html`
                  <div class="muted">No matching events.</div>
                `
              : props.events.map(
                  (event) => html`
                    <button
                      class="list-item"
                      style="width: 100%; text-align: left;"
                      @click=${() => props.onSelectEvent(event.eventId)}
                    >
                      <div class="list-main">
                        <div class="list-title">${event.eventType}</div>
                        <div class="list-sub">${formatTime(event.timestamp)} · ${event.traceId}</div>
                      </div>
                      <div class="list-meta mono">${event.agentId}</div>
                    </button>
                  `,
                )
          }
        </div>
        <div>
          <div class="muted">Event Details</div>
          <pre class="code-block">${selected ? JSON.stringify(selected, null, 2) : "Select an event"}</pre>
          <div class="muted" style="margin-top: 10px;">Trace View</div>
          <div class="list" style="max-height: 180px; overflow: auto; margin-top: 6px;">
            ${
              props.traceEvents.length === 0
                ? html`
                    <div class="muted">No trace selected.</div>
                  `
                : props.traceEvents.map(
                    (event) => html`<div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${event.eventType}</div>
                        <div class="list-sub">${formatTime(event.timestamp)} · span ${event.spanId ?? "-"}</div>
                      </div>
                    </div>`,
                  )
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderSpend(props: ObservabilityViewProps) {
  const spend = props.derivedSpend;
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Spend</div>
          <div class="card-sub">Live rollups from model call events.</div>
        </div>
        <label class="field" style="min-width: 150px;">
          <span>Window</span>
          <select
            .value=${props.spendWindow}
            @change=${(event: Event) =>
              props.onSpendWindowChange((event.target as HTMLSelectElement).value as SpendWindow)}
          >
            <option value="15m">Last 15m</option>
            <option value="1h">Last 1h</option>
            <option value="today">Today</option>
          </select>
        </label>
      </div>
      <div class="grid grid-cols-3" style="margin-top: 12px; gap: 10px;">
        <div class="card">
          <div class="muted">Calls</div>
          <div class="page-title">${formatNumber(spend.totals.calls)}</div>
        </div>
        <div class="card">
          <div class="muted">Tokens in/out</div>
          <div class="page-title">
            ${formatNumber(spend.totals.tokensIn)} / ${formatNumber(spend.totals.tokensOut)}
          </div>
        </div>
        <div class="card">
          <div class="muted">Cost (USD)</div>
          <div class="page-title">${spend.totals.costUsd.toFixed(6)}</div>
        </div>
      </div>
      <div class="grid grid-cols-2" style="margin-top: 12px; gap: 12px; align-items: start;">
        <div class="card">
          <div class="card-title">By Model</div>
          <div class="list" style="margin-top: 8px; max-height: 280px; overflow: auto;">
            ${
              spend.byModel.length === 0
                ? html`
                    <div class="muted">No model usage in selected window.</div>
                  `
                : spend.byModel.map(
                    (entry) => html`<div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${entry.modelRef}</div>
                        <div class="list-sub">calls ${entry.calls} · in ${entry.tokensIn} · out ${entry.tokensOut}</div>
                      </div>
                      <div class="list-meta mono">${entry.costUsd.toFixed(6)}</div>
                    </div>`,
                  )
            }
          </div>
        </div>
        <div class="card">
          <div class="card-title">By Agent</div>
          <div class="list" style="margin-top: 8px; max-height: 280px; overflow: auto;">
            ${
              spend.byAgent.length === 0
                ? html`
                    <div class="muted">No agent usage in selected window.</div>
                  `
                : spend.byAgent.map(
                    (entry) => html`<div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${entry.agentId}</div>
                        <div class="list-sub">calls ${entry.calls} · in ${entry.tokensIn} · out ${entry.tokensOut}</div>
                      </div>
                      <div class="list-meta mono">${entry.costUsd.toFixed(6)}</div>
                    </div>`,
                  )
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderHealth(props: ObservabilityViewProps) {
  const summary = props.healthSummary;
  return html`
    <section class="card">
      <div class="card-title">Model Health</div>
      <div class="card-sub">Latest provider/model status and fallback frequency.</div>
      <div class="grid grid-cols-2" style="margin-top: 12px; gap: 12px; align-items: start;">
        <div class="card">
          <div class="card-title">Models</div>
          <div class="list" style="margin-top: 8px; max-height: 320px; overflow: auto;">
            ${
              !summary || summary.models.length === 0
                ? html`
                    <div class="muted">No health updates received yet.</div>
                  `
                : summary.models.map(
                    (entry) => html`<div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${entry.modelRef}</div>
                        <div class="list-sub">
                          status ${entry.status} · circuit ${entry.circuitState} · failRate ${entry.failureRate}
                        </div>
                      </div>
                      <div class="list-meta mono">${entry.consecutiveFailures}/${entry.totalCalls}</div>
                    </div>`,
                  )
            }
          </div>
        </div>
        <div class="card">
          <div class="card-title">Fallback Frequency</div>
          <div class="list" style="margin-top: 8px; max-height: 320px; overflow: auto;">
            ${
              props.fallbackCounts.length === 0
                ? html`
                    <div class="muted">No fallback activity in selected spend window.</div>
                  `
                : props.fallbackCounts.map(
                    (entry) => html`<div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${entry.fromModelRef}</div>
                        <div class="list-sub">→ ${entry.toModelRef}</div>
                      </div>
                      <div class="list-meta mono">${entry.count}</div>
                    </div>`,
                  )
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

export function renderObservability(props: ObservabilityViewProps) {
  const offline = !props.connected;
  const unavailable = !props.status.available;
  return html`
    <section class="card" style="margin-bottom: 12px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Observability</div>
          <div class="card-sub">Live runtime stream from the gateway websocket.</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button class="btn ${props.section === "audit" ? "primary" : ""}" @click=${() => props.onSectionChange("audit")}>Live Audit</button>
          <button class="btn ${props.section === "spend" ? "primary" : ""}" @click=${() => props.onSectionChange("spend")}>Spend</button>
          <button class="btn ${props.section === "health" ? "primary" : ""}" @click=${() => props.onSectionChange("health")}>Model Health</button>
        </div>
      </div>
      ${
        offline
          ? html`
              <div class="callout warn" style="margin-top: 10px">Gateway disconnected.</div>
            `
          : unavailable
            ? html`
                <div class="callout warn" style="margin-top: 10px">
                  Observability stream is disabled. Enable <span class="mono">observability.stream.enabled</span>.
                </div>
              `
            : props.status.lastError
              ? html`<div class="callout danger" style="margin-top: 10px;">${props.status.lastError}</div>`
              : html`<div class="muted" style="margin-top: 10px;">Subscribed · last event ts ${props.status.lastSeenTs || 0}</div>`
      }
    </section>

    ${props.section === "audit" ? renderAudit(props) : ""}
    ${props.section === "spend" ? renderSpend(props) : ""}
    ${props.section === "health" ? renderHealth(props) : ""}
  `;
}
