import { useEffect, useState } from "react";
import type { DataProviderMode, DataProviderStatus, ModeState } from "@copylab/shared";
import {
  captureProviderParityBaseline,
  getProviderParityBaselineStatus,
  saveDataProviderProfile
} from "../api";
import {
  createProviderProfileRequest,
  dataProviderChangesAllowed,
  dataProviderModeAvailable,
  providerConfirmation,
  providerEndpointsValid
} from "../provider-profile";
import { count, titleCase } from "../format";
import type { ProviderParityBaselineStatus, ToastTone } from "../types";
import { Button, Modal, StatusDot } from "./Primitives";

interface DataProviderControlProps {
  status: DataProviderStatus;
  appMode: ModeState;
  csrfToken: string;
  onRefresh: () => Promise<void>;
  notify: (tone: ToastTone, title: string, detail?: string) => void;
}

const MODE_OPTIONS: Array<{
  mode: DataProviderMode;
  title: string;
  detail: string;
}> = [
  {
    mode: "MANAGED",
    title: "Managed",
    detail: "Birdeye and Helius remain the active data path."
  },
  {
    mode: "SHADOW",
    title: "Shadow compare",
    detail: "Managed data stays primary while the local stack records parity evidence."
  },
  {
    mode: "SELF_HOSTED",
    title: "Self-hosted",
    detail: "The proven local stack becomes the active data path."
  }
];

const BASELINE_CONFIRMATION = "CAPTURE FROZEN PARITY BASELINE" as const;

function baselineDescription(baseline: ProviderParityBaselineStatus | undefined): string {
  if (!baseline || baseline.status === "NOT_STARTED") return "Frozen same-cutoff proof has not been requested.";
  if (baseline.status === "ACTIVE") {
    return `${baseline.acquisitions.length} immutable comparisons are bound to the active proof epoch.`;
  }
  if (baseline.status === "BLOCKED" || baseline.status === "FAILED") {
    return `${baseline.blockers.length} explicit proof blocker${baseline.blockers.length === 1 ? "" : "s"} recorded.`;
  }
  return `${baseline.acquisitions.length} immutable comparison${baseline.acquisitions.length === 1 ? "" : "s"} captured so far.`;
}

function statusDescription(status: DataProviderStatus): string {
  if (status.profile.mode === "MANAGED") {
    return "Managed Birdeye and Helius are primary while local parity evidence is built.";
  }
  if (status.profile.mode === "SHADOW") {
    return `Managed results stay primary while the self-hosted path is compared. ${status.blockers.length} rollout blocker${status.blockers.length === 1 ? "" : "s"} remain.`;
  }
  return status.selfHostedPaperSoak.ready
    ? "Self-hosted Solana and local wallet analytics passed the independent PAPER soak."
    : `Self-hosted data is active in PAPER. ${status.selfHostedPaperSoak.blockers.length} live-soak blocker${status.selfHostedPaperSoak.blockers.length === 1 ? "" : "s"} remain.`;
}

export function DataProviderControl({
  status,
  appMode,
  csrfToken,
  onRefresh,
  notify
}: DataProviderControlProps) {
  const [open, setOpen] = useState(false);
  const [targetMode, setTargetMode] = useState<DataProviderMode>(status.profile.mode);
  const [httpUrl, setHttpUrl] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [emergencyHttpUrl, setEmergencyHttpUrl] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [baseline, setBaseline] = useState<ProviderParityBaselineStatus>();
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [baselineConfirmation, setBaselineConfirmation] = useState("");
  const [baselineBusy, setBaselineBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getProviderParityBaselineStatus(controller.signal)
      .then(setBaseline)
      .catch(() => undefined);
    return () => controller.abort();
  }, [status.profile.mode, status.parity.baselineRunId, status.parity.baselineRunStatus]);

  const paperSafe = dataProviderChangesAllowed(appMode);
  const expectedConfirmation = providerConfirmation(targetMode);
  const endpointsRequired = targetMode !== "MANAGED";
  const endpointsValid = !endpointsRequired || providerEndpointsValid(httpUrl, wsUrl, emergencyHttpUrl);
  const unchangedManaged = targetMode === "MANAGED" && status.profile.mode === "MANAGED";
  const canSubmit = paperSafe && endpointsValid && !unchangedManaged && confirmation === expectedConfirmation;
  const readinessState = status.profile.mode === "MANAGED"
    ? true
    : status.profile.mode === "SELF_HOSTED"
      ? status.selfHostedPaperSoak.ready || "warning"
    : status.selfHostedReady
      ? true
      : "warning";
  const activeProof = status.parity.proofEpochStatus === "ACTIVE";
  const baselineStatus = activeProof
    ? "ACTIVE"
    : baseline?.status ?? status.parity.baselineRunStatus ?? "NOT_STARTED";
  const baselineAllowed = appMode === "PAPER" &&
    status.profile.mode === "SHADOW" &&
    baselineStatus !== "ACTIVE";
  const baselineCanSubmit = baselineAllowed && baselineConfirmation === BASELINE_CONFIRMATION;

  function clearSensitiveState() {
    setHttpUrl("");
    setWsUrl("");
    setEmergencyHttpUrl("");
    setConfirmation("");
  }

  function openControl() {
    setTargetMode(status.profile.mode);
    clearSensitiveState();
    setOpen(true);
  }

  function closeControl() {
    if (busy) return;
    clearSensitiveState();
    setOpen(false);
  }

  function selectMode(mode: DataProviderMode) {
    setTargetMode(mode);
    setConfirmation("");
    if (mode === "MANAGED") {
      setHttpUrl("");
      setWsUrl("");
      setEmergencyHttpUrl("");
    }
  }

  async function submitChange() {
    if (!canSubmit) return;
    const request = createProviderProfileRequest(targetMode, httpUrl, wsUrl, emergencyHttpUrl);
    setBusy(true);
    clearSensitiveState();
    try {
      await saveDataProviderProfile(request, csrfToken);
      notify(
        "success",
        `${titleCase(targetMode)} data path saved`,
        targetMode === "SHADOW"
          ? "Managed data remains primary while parity evidence accumulates."
          : "The provider transition was validated and written to the audit ledger."
      );
      setOpen(false);
      await onRefresh();
    } catch (reason) {
      notify(
        "danger",
        "Data-provider change blocked",
        reason instanceof Error ? reason.message : "The local server rejected the transition."
      );
    } finally {
      setBusy(false);
    }
  }

  function closeBaselineControl() {
    if (baselineBusy) return;
    setBaselineConfirmation("");
    setBaselineOpen(false);
  }

  async function submitBaselineCapture() {
    if (!baselineCanSubmit) return;
    setBaselineBusy(true);
    setBaselineConfirmation("");
    try {
      const result = await captureProviderParityBaseline(BASELINE_CONFIRMATION, csrfToken);
      setBaseline(result);
      notify(
        result.status === "ACTIVE" ? "success" : result.status === "BLOCKED" ? "info" : "danger",
        result.status === "ACTIVE" ? "Frozen parity proof activated" : "Frozen parity proof stayed locked",
        result.status === "ACTIVE"
          ? `${result.acquisitions.length} same-cutoff comparisons were bound to the active proof epoch.`
          : result.blockers.map((entry) => entry.message).join(" ") || "The local server refused incomplete proof."
      );
      setBaselineOpen(false);
      await onRefresh();
    } catch (reason) {
      notify(
        "danger",
        "Parity capture blocked",
        reason instanceof Error ? reason.message : "The local server rejected the frozen capture."
      );
    } finally {
      setBaselineBusy(false);
    }
  }

  return (
    <>
      <article className="provider-card data-provider-card">
        <div className="provider-card-top">
          <span className="provider-monogram">L</span>
          <StatusDot
            ok={readinessState}
            label={status.profile.mode === "SELF_HOSTED"
              ? status.selfHostedPaperSoak.ready ? "Paper soak ready" : "Paper soak running"
              : status.selfHostedReady ? "Parity ready" : titleCase(status.profile.mode)}
          />
        </div>
        <div className="data-provider-summary">
          <strong>Local data stack · {titleCase(status.profile.mode)}</strong>
          <p title={statusDescription(status)}>{statusDescription(status)}</p>
        </div>
        <div className="provider-origins" aria-label="Redacted provider endpoints">
          <span><b>RPC</b><code>{status.profile.httpOrigin ?? "managed"}</code></span>
          <span><b>WSS</b><code>{status.profile.wsOrigin ?? "managed"}</code></span>
          <span><b>Exit RPC</b><code>{status.profile.emergencyHttpOrigin ?? "managed"}</code></span>
        </div>
        {status.profile.mode === "SHADOW" && (
          <div className="parity-baseline-summary">
            <div>
              <span className={`status-pill status-${baselineStatus.toLowerCase().replace("_", "-")}`}>
                <StatusDot ok={baselineStatus === "ACTIVE" ? true : baselineStatus === "FAILED" ? false : "warning"} />
                {titleCase(baselineStatus)}
              </span>
              <small>{baselineDescription(baseline)}</small>
            </div>
            <Button
              tone="ghost"
              disabled={!baselineAllowed || baselineBusy}
              title={activeProof
                ? "The active frozen proof is immutable; change the provider profile to reset it"
                : baselineAllowed
                  ? "Freeze and attempt one same-cutoff provider parity capture"
                  : "Frozen capture requires PAPER mode with SHADOW active"}
              onClick={() => {
                setBaselineConfirmation("");
                setBaselineOpen(true);
              }}
            >
              Capture proof
            </Button>
          </div>
        )}
        <footer>
          <span>{count(status.priceCoverage.count)} SOL price points</span>
          <span>{count(status.priceCoverage.pendingSwapReprices ?? 0)} SOL swaps awaiting price</span>
          {(status.priceCoverage.outOfHorizonSwapReprices ?? 0) > 0 && (
            <span>{count(status.priceCoverage.outOfHorizonSwapReprices ?? 0)} older unpriced swaps retained for audit</span>
          )}
          <span>Exit path {status.emergencyExitRpc.ok ? "ready" : "blocked"}</span>
          <span>{status.profile.mode === "SELF_HOSTED"
            ? `${status.selfHostedPaperSoak.elapsedDays.toFixed(1)} / ${status.selfHostedPaperSoak.requiredDays} soak days`
            : `${status.parity.latestMatches} matches · ${status.parity.latestDivergences} differences`}</span>
        </footer>
        <Button
          className="provider-configure"
          tone="ghost"
          disabled={!paperSafe}
          title={paperSafe ? "Configure the data path" : "Return to PAPER mode before changing data providers"}
          onClick={openControl}
        >
          Configure
        </Button>
      </article>

      <Modal
        open={open}
        onClose={closeControl}
        title="Configure the data path"
        description="Provider changes are allowed only in PAPER mode with no open bot-created positions. Full endpoint URLs are sent once to the encrypted local vault and are never stored by this browser."
        danger={targetMode === "SELF_HOSTED"}
      >
        <form className="provider-profile-form" autoComplete="off" onSubmit={(event) => {
          event.preventDefault();
          void submitChange();
        }}>
          <fieldset className="provider-mode-options" disabled={busy}>
            <legend>Data path</legend>
            {MODE_OPTIONS.map((option) => {
              const selfHostedBlocked = option.mode !== status.profile.mode &&
                !dataProviderModeAvailable(option.mode, status.selfHostedReady);
              return (
                <button
                  key={option.mode}
                  type="button"
                  className={targetMode === option.mode ? "selected" : ""}
                  aria-pressed={targetMode === option.mode}
                  disabled={selfHostedBlocked}
                  onClick={() => selectMode(option.mode)}
                >
                  <span><strong>{option.title}</strong>{option.mode === status.profile.mode && <small>Current</small>}</span>
                  <p>{option.detail}</p>
                  {selfHostedBlocked && <em>Locked until every parity gate passes</em>}
                </button>
              );
            })}
          </fieldset>

          {endpointsRequired && (
            <div className="provider-secret-fields">
              <p>Enter the complete endpoints. They may contain credentials, so the values stay masked and are cleared immediately after submission.</p>
              <label>
                <span>Solana HTTP RPC URL</span>
                <input
                  type="password"
                  value={httpUrl}
                  onChange={(event) => setHttpUrl(event.target.value)}
                  placeholder="https://rpc.example.invalid"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-1p-ignore="true"
                  required
                />
              </label>
              <label>
                <span>Solana WebSocket URL</span>
                <input
                  type="password"
                  value={wsUrl}
                  onChange={(event) => setWsUrl(event.target.value)}
                  placeholder="wss://rpc.example.invalid"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-1p-ignore="true"
                  required
                />
              </label>
              <label>
                <span>Independent emergency-exit HTTP RPC URL</span>
                <input
                  type="password"
                  value={emergencyHttpUrl}
                  onChange={(event) => setEmergencyHttpUrl(event.target.value)}
                  placeholder="https://independent-rpc.example.invalid"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-1p-ignore="true"
                  required
                />
              </label>
              {(httpUrl || wsUrl || emergencyHttpUrl) && !endpointsValid && (
                <span className="provider-form-warning" role="alert">Use http(s) for both RPCs and ws(s) for WebSocket. The exit RPC must use a different host or port. Embedded username/password credentials are rejected.</span>
              )}
            </div>
          )}

          {status.profile.mode !== "SELF_HOSTED" && !status.selfHostedReady && status.blockers.length > 0 && (
            <div className="provider-blockers">
              <strong>Self-hosted promotion remains locked</strong>
              <ul>{status.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
            </div>
          )}

          {status.profile.mode === "SELF_HOSTED" && !status.selfHostedPaperSoak.ready && (
            <div className="provider-blockers">
              <strong>Manual live remains locked during the self-hosted PAPER soak</strong>
              <ul>{status.selfHostedPaperSoak.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
            </div>
          )}

          <div className={`confirmation-box ${targetMode === "SELF_HOSTED" ? "" : "confirmation-neutral"}`}>
            <p>Type <code>{expectedConfirmation}</code> to confirm.</p>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value.toUpperCase())}
              placeholder={expectedConfirmation}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="modal-actions">
            <Button type="button" tone="ghost" disabled={busy} onClick={closeControl}>Cancel</Button>
            <Button
              type="submit"
              tone={targetMode === "SELF_HOSTED" ? "danger" : "primary"}
              busy={busy}
              disabled={!canSubmit}
            >
              Validate & save
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={baselineOpen}
        onClose={closeBaselineControl}
        title="Capture frozen parity proof"
        description="This freezes one completed 90-day generation and attempts all 21 managed-versus-local comparisons at its exact cutoff. Missing point-in-time support, empty gap evidence, drift, or any mismatch remains a durable blocker and cannot unlock self-hosted mode."
      >
        <form className="provider-profile-form" onSubmit={(event) => {
          event.preventDefault();
          void submitBaselineCapture();
        }}>
          <div className="parity-baseline-detail">
            <div><span>Current run</span><strong>{titleCase(baselineStatus)}</strong></div>
            <div><span>Bound comparisons</span><strong>{count(baseline?.acquisitions.length ?? 0)} / 21</strong></div>
            <div><span>Frozen subjects</span><strong>{count(baseline?.subjects?.length ?? 0)} / 5</strong></div>
          </div>
          {baseline && baseline.blockers.length > 0 && (
            <div className="provider-blockers">
              <strong>Recorded blockers</strong>
              <ul>{baseline.blockers.map((entry) => (
                <li key={`${entry.code}:${entry.message}`}><code>{entry.code}</code> · {entry.message}</li>
              ))}</ul>
            </div>
          )}
          <div className="confirmation-box confirmation-neutral">
            <p>Type <code>{BASELINE_CONFIRMATION}</code> to confirm.</p>
            <input
              value={baselineConfirmation}
              onChange={(event) => setBaselineConfirmation(event.target.value.toUpperCase())}
              placeholder={BASELINE_CONFIRMATION}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="modal-actions">
            <Button type="button" tone="ghost" disabled={baselineBusy} onClick={closeBaselineControl}>Cancel</Button>
            <Button type="submit" tone="primary" busy={baselineBusy} disabled={!baselineCanSubmit}>
              Freeze & capture
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
