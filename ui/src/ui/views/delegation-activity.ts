import { html } from "lit";
import type { ObsEventRecord } from "../../../../src/observability/stream-protocol.js";

export type DelegationActivityProps = {
  events: ObsEventRecord[];
  traceFilter: string;
  onTraceFilterChange: (next: string) => void;
};

type DelegationPayload = {
  fromAgentId?: unknown;
  toAgentId?: unknown;
  status?: unknown;
  artifactIds?: unknown;
  artifactId?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatEventTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "";
  }
}

function artifactCount(payload: DelegationPayload): number {
  const listCount = Array.isArray(payload.artifactIds) ? payload.artifactIds.length : 0;
  const singleCount = typeof payload.artifactId === "string" ? 1 : 0;
  return listCount + singleCount;
}

type TraceActivity = {
  traceId: string;
  lastTs: number;
  fromAgentId: string;
  toAgentId: string;
  status: string;
  latencyMs: number | null;
  events: number;
  artifacts: number;
};

function toTraceActivities(events: ObsEventRecord[]): TraceActivity[] {
  const grouped = new Map<string, TraceActivity>();
  for (const event of events) {
    const payload = (event.payload ?? {}) as DelegationPayload & { latencyMs?: unknown };
    const existing = grouped.get(event.traceId);
    const current = existing ?? {
      traceId: event.traceId,
      lastTs: event.timestamp,
      fromAgentId: "",
      toAgentId: "",
      status: "",
      latencyMs: null,
      events: 0,
      artifacts: 0,
    };
    current.lastTs = Math.max(current.lastTs, event.timestamp);
    const from = asString(payload.fromAgentId);
    const to = asString(payload.toAgentId);
    const status = asString(payload.status);
    if (from) {
      current.fromAgentId = from;
    }
    if (to) {
      current.toAgentId = to;
    }
    if (status) {
      current.status = status;
    }
    const metricsLatency =
      event.metrics && typeof event.metrics.latencyMs === "number" && Number.isFinite(event.metrics.latencyMs)
        ? event.metrics.latencyMs
        : typeof payload.latencyMs === "number" && Number.isFinite(payload.latencyMs)
          ? payload.latencyMs
          : null;
    if (metricsLatency != null) {
      current.latencyMs = metricsLatency;
    }
    current.events += 1;
    current.artifacts += artifactCount(payload);
    grouped.set(event.traceId, current);
  }
  return [...grouped.values()].toSorted((a, b) => b.lastTs - a.lastTs);
}

export function renderDelegationActivity(props: DelegationActivityProps) {
  const traceFilter = props.traceFilter.trim();
  const visible = traceFilter
    ? props.events.filter((event) => event.traceId.includes(traceFilter))
    : props.events;
  const rows = toTraceActivities(visible);
  return html`
    <section class="grid">
      <div class="card">
        <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
            <div class="card-title">Delegation Activity</div>
          <div class="muted">Recent agent call/message + artifact events from observability stream.</div>
        </div>
          <div class="row">
          <label>
            Trace
            <input
              type="text"
                style="margin-left: 8px;"
              .value=${props.traceFilter}
              @input=${(event: Event) =>
                props.onTraceFilterChange((event.target as HTMLInputElement).value)}
              placeholder="trace id filter"
            />
          </label>
        </div>
      </div>
      ${
        rows.length === 0
          ? html`<div class="muted">No delegation activity yet.</div>`
          : html`
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Last</th>
                      <th>Trace</th>
                      <th>Events</th>
                      <th>From</th>
                      <th>To</th>
                      <th>Status</th>
                      <th>Latency</th>
                      <th>Artifacts</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rows.map((row) => {
                      return html`
                        <tr>
                          <td>${formatEventTime(row.lastTs)}</td>
                          <td><code>${row.traceId}</code></td>
                          <td>${row.events}</td>
                          <td>${row.fromAgentId || "-"}</td>
                          <td>${row.toAgentId || "-"}</td>
                          <td>${row.status || "-"}</td>
                          <td>${row.latencyMs == null ? "-" : `${row.latencyMs}ms`}</td>
                          <td>${row.artifacts}</td>
                        </tr>
                      `;
                    })}
                  </tbody>
                </table>
              </div>
            `
      }
      </div>
    </section>
  `;
}
