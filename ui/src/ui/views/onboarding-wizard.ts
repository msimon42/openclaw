import { html, nothing } from "lit";

type WizardOption = {
  value: unknown;
  label: string;
  hint?: string;
};

type WizardStep = {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
  title?: string;
  message?: string;
  options?: WizardOption[];
  placeholder?: string;
  sensitive?: boolean;
};

export type OnboardingWizardProps = {
  connected: boolean;
  starting: boolean;
  advancing: boolean;
  sessionId: string | null;
  status: "idle" | "running" | "done" | "cancelled" | "error";
  error: string | null;
  step: WizardStep | null;
  startMode: "local" | "remote";
  startProfile: "standard" | "enhanced";
  startNonInteractive: boolean;
  startForceReset: boolean;
  answerText: string;
  answerConfirm: boolean;
  answerValue: unknown;
  answerMultiValues: unknown[];
  onStart: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  onStartModeChange: (value: "local" | "remote") => void;
  onStartProfileChange: (value: "standard" | "enhanced") => void;
  onStartNonInteractiveChange: (value: boolean) => void;
  onStartForceResetChange: (value: boolean) => void;
  onAnswerTextChange: (value: string) => void;
  onAnswerConfirmChange: (value: boolean) => void;
  onAnswerValueChange: (value: unknown) => void;
  onAnswerMultiToggle: (value: unknown, checked: boolean) => void;
};

function valueEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function renderStepInput(props: OnboardingWizardProps) {
  if (!props.step) {
    return html`
      <div class="muted">No active step.</div>
    `;
  }

  if (
    props.step.type === "note" ||
    props.step.type === "progress" ||
    props.step.type === "action"
  ) {
    return html`<div class="callout" style="margin-top: 12px;">${props.step.message ?? "Continue to next step."}</div>`;
  }

  if (props.step.type === "text") {
    return html`
      <label class="field" style="margin-top: 12px;">
        <span>Answer</span>
        <input
          type=${props.step.sensitive ? "password" : "text"}
          .value=${props.answerText}
          placeholder=${props.step.placeholder ?? ""}
          @input=${(event: Event) =>
            props.onAnswerTextChange((event.target as HTMLInputElement).value)}
        />
      </label>
    `;
  }

  if (props.step.type === "confirm") {
    return html`
      <div class="stack" style="margin-top: 12px; gap: 8px;">
        <label class="row" style="gap: 8px; align-items: center;">
          <input
            type="radio"
            name="wizard-confirm"
            .checked=${props.answerConfirm}
            @change=${() => props.onAnswerConfirmChange(true)}
          />
          <span>Yes</span>
        </label>
        <label class="row" style="gap: 8px; align-items: center;">
          <input
            type="radio"
            name="wizard-confirm"
            .checked=${!props.answerConfirm}
            @change=${() => props.onAnswerConfirmChange(false)}
          />
          <span>No</span>
        </label>
      </div>
    `;
  }

  if (props.step.type === "select") {
    return html`
      <div class="stack" style="margin-top: 12px; gap: 8px;">
        ${(props.step.options ?? []).map(
          (option) => html`
            <label class="field" style="margin: 0;">
              <span class="row" style="gap: 8px; align-items: center;">
                <input
                  type="radio"
                  name="wizard-select"
                  .checked=${valueEquals(props.answerValue, option.value)}
                  @change=${() => props.onAnswerValueChange(option.value)}
                />
                <strong>${option.label}</strong>
              </span>
              ${option.hint ? html`<span class="muted">${option.hint}</span>` : nothing}
            </label>
          `,
        )}
      </div>
    `;
  }

  if (props.step.type === "multiselect") {
    return html`
      <div class="stack" style="margin-top: 12px; gap: 8px;">
        ${(props.step.options ?? []).map((option) => {
          const checked = props.answerMultiValues.some((entry) => valueEquals(entry, option.value));
          return html`
            <label class="field" style="margin: 0;">
              <span class="row" style="gap: 8px; align-items: center;">
                <input
                  type="checkbox"
                  .checked=${checked}
                  @change=${(event: Event) =>
                    props.onAnswerMultiToggle(
                      option.value,
                      (event.target as HTMLInputElement).checked,
                    )}
                />
                <strong>${option.label}</strong>
              </span>
              ${option.hint ? html`<span class="muted">${option.hint}</span>` : nothing}
            </label>
          `;
        })}
      </div>
    `;
  }

  return html`<div class="muted">Unsupported step type: ${props.step.type}</div>`;
}

export function renderOnboardingWizard(props: OnboardingWizardProps) {
  const running = props.status === "running" && Boolean(props.sessionId);

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">Wizard Start</div>
        <div class="card-sub">Run onboarding through gateway RPC.</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>Mode</span>
            <select
              .value=${props.startMode}
              @change=${(event: Event) =>
                props.onStartModeChange(
                  (event.target as HTMLSelectElement).value as "local" | "remote",
                )}
            >
              <option value="local">local</option>
              <option value="remote">remote</option>
            </select>
          </label>
          <label class="field">
            <span>Profile</span>
            <select
              .value=${props.startProfile}
              @change=${(event: Event) =>
                props.onStartProfileChange(
                  (event.target as HTMLSelectElement).value as "standard" | "enhanced",
                )}
            >
              <option value="standard">standard</option>
              <option value="enhanced">enhanced</option>
            </select>
          </label>
          <label class="field" style="margin-top: 8px;">
            <span class="row" style="gap: 8px; align-items: center;">
              <input
                type="checkbox"
                .checked=${props.startNonInteractive}
                @change=${(event: Event) =>
                  props.onStartNonInteractiveChange((event.target as HTMLInputElement).checked)}
              />
              <span>nonInteractive</span>
            </span>
          </label>
          <label class="field" style="margin-top: 8px;">
            <span class="row" style="gap: 8px; align-items: center;">
              <input
                type="checkbox"
                .checked=${props.startForceReset}
                @change=${(event: Event) =>
                  props.onStartForceResetChange((event.target as HTMLInputElement).checked)}
              />
              <span>forceReset</span>
            </span>
          </label>
        </div>
        <div class="row" style="margin-top: 14px; gap: 8px;">
          <button
            class="btn primary"
            ?disabled=${!props.connected || props.starting || props.advancing || running}
            @click=${props.onStart}
          >
            ${props.starting ? "Starting..." : "Start Wizard"}
          </button>
          <button class="btn" ?disabled=${!running || props.advancing} @click=${props.onCancel}>
            Cancel
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Status</div>
        <div class="card-sub">Session and execution state.</div>
        <div class="stack" style="margin-top: 12px; gap: 6px;">
          <div><span class="muted">Session:</span> <span class="mono">${props.sessionId ?? "-"}</span></div>
          <div><span class="muted">Status:</span> <strong>${props.status}</strong></div>
          ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
        </div>
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Current Step</div>
      <div class="card-sub">Review and submit the current wizard step payload.</div>
      ${
        props.step
          ? html`
              <div class="stack" style="margin-top: 12px; gap: 8px;">
                <div><span class="muted">Step ID:</span> <span class="mono">${props.step.id}</span></div>
                <div><span class="muted">Type:</span> ${props.step.type}</div>
                ${props.step.title ? html`<div><strong>${props.step.title}</strong></div>` : nothing}
                ${props.step.message ? html`<div>${props.step.message}</div>` : nothing}
                ${renderStepInput(props)}
              </div>
            `
          : html`
              <div class="muted" style="margin-top: 12px">No active step.</div>
            `
      }
      <div class="row" style="margin-top: 14px; gap: 8px;">
        <button
          class="btn primary"
          ?disabled=${!running || !props.step || props.advancing}
          @click=${props.onSubmit}
        >
          ${props.advancing ? "Submitting..." : "Submit / Next"}
        </button>
      </div>
    </section>
  `;
}
