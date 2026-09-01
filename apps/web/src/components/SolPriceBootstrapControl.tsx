import { useState } from "react";
import type { ModeState, SolPriceBootstrapStatus } from "@copylab/shared";
import {
  pauseSolPriceBootstrap,
  savePythBenchmarksApiKey,
  startSolPriceBootstrap
} from "../api";
import { count, dateTime, percent, titleCase } from "../format";
import {
  PAUSE_PYTH_BOOTSTRAP_CONFIRMATION,
  SAVE_PYTH_API_KEY_CONFIRMATION,
  START_PYTH_BOOTSTRAP_CONFIRMATION,
  pythBenchmarksCredentialChangeAllowed,
  solPriceBootstrapPauseAllowed,
  solPriceBootstrapStartAllowed,
  solPriceBootstrapStartLabel
} from "../sol-price-bootstrap";
import type { ToastTone } from "../types";
import { Button, Modal, SectionHeader, StatusDot } from "./Primitives";

interface SolPriceBootstrapControlProps {
  status: SolPriceBootstrapStatus;
  appMode: ModeState;
  csrfToken: string;
  onRefresh: () => Promise<void>;
  notify: (tone: ToastTone, title: string, detail?: string) => void;
}

type BootstrapAction = "start" | "pause";

function phaseTone(status: SolPriceBootstrapStatus): true | false | "warning" {
  if (status.phase === "COMPLETE") return true;
  if (status.phase === "FAILED" || !status.checkpointValid) return false;
  return "warning";
}

function phaseDescription(status: SolPriceBootstrapStatus): string {
  if (!status.checkpointValid) return "The durable cursor is invalid. No historical request can run.";
  if (status.phase === "IDLE") return "Optional and dormant. It will not make a request until you explicitly start it.";
  if (status.phase === "RUNNING") {
    return status.activeInProcess
      ? "Fetching bounded provider pages and committing exact ten-minute points. Existing timestamps from every source stay untouched."
      : "The authorized cursor is durable and resumes automatically after a healthy SETUP or PAPER restart.";
  }
  if (status.phase === "RETRY_WAIT") return "A transient provider failure is waiting for its durable retry time.";
  if (status.phase === "PAUSED") return "Paused safely. The next grid timestamp remains durable.";
  if (status.phase === "COMPLETE") {
    return status.refreshAvailable
      ? "This generation is complete but its rolling edge is stale. An explicit refresh creates a current insert-only 90-day generation."
      : "The current rolling 90-day grid is complete. Ongoing Jupiter freshness is still required.";
  }
  return "Stopped fail-closed at the current timestamp. Review the error before explicitly resuming.";
}

export function SolPriceBootstrapControl({
  status,
  appMode,
  csrfToken,
  onRefresh,
  notify
}: SolPriceBootstrapControlProps) {
  const [action, setAction] = useState<BootstrapAction | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [pythApiKey, setPythApiKey] = useState("");
  const [keyConfirmation, setKeyConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const canStart = solPriceBootstrapStartAllowed(appMode, status);
  const canPause = solPriceBootstrapPauseAllowed(status);
  const canChangeKey = pythBenchmarksCredentialChangeAllowed(appMode);
  const pythConfigured = status.pythAuthenticationConfigured ?? status.authenticationConfigured;
  const expected = action === "pause"
    ? PAUSE_PYTH_BOOTSTRAP_CONFIRMATION
    : START_PYTH_BOOTSTRAP_CONFIRMATION;
  const progress = Math.max(0, Math.min(100, status.progressPercent));

  function openAction(next: BootstrapAction) {
    setConfirmation("");
    setAction(next);
  }

  function closeAction() {
    if (busy) return;
    setConfirmation("");
    setAction(null);
  }

  async function submit() {
    if (!action || confirmation !== expected) return;
    setBusy(true);
    try {
      if (action === "start") {
        await startSolPriceBootstrap(START_PYTH_BOOTSTRAP_CONFIRMATION, csrfToken);
        notify(
          "success",
          status.phase === "IDLE"
            ? "History bootstrap started"
            : status.phase === "COMPLETE"
              ? "Rolling history refresh started"
              : "History bootstrap resumed",
          "The explicitly authorized frozen cursor is running through a bounded, authenticated provider. Existing timestamps remain untouched."
        );
      } else {
        await pauseSolPriceBootstrap(PAUSE_PYTH_BOOTSTRAP_CONFIRMATION, csrfToken);
        notify("success", "History bootstrap paused", "Progress is durable and can be resumed later.");
      }
      setAction(null);
      setConfirmation("");
      await onRefresh();
    } catch (reason) {
      notify(
        "danger",
        action === "start" ? "Bootstrap start blocked" : "Bootstrap pause failed",
        reason instanceof Error ? reason.message : "The local server rejected the request."
      );
    } finally {
      setBusy(false);
    }
  }

  function closeKeyModal() {
    if (busy) return;
    setPythApiKey("");
    setKeyConfirmation("");
    setKeyModalOpen(false);
  }

  async function submitKey() {
    const apiKey = pythApiKey.trim();
    if (
      !canChangeKey
      || apiKey.length < 8
      || keyConfirmation !== SAVE_PYTH_API_KEY_CONFIRMATION
    ) return;
    setBusy(true);
    setPythApiKey("");
    setKeyConfirmation("");
    try {
      await savePythBenchmarksApiKey(apiKey, SAVE_PYTH_API_KEY_CONFIRMATION, csrfToken);
      notify(
        "success",
        "Pyth API key saved",
        "The key was validated, encrypted for this Windows account, and removed from the form."
      );
      setKeyModalOpen(false);
      await onRefresh();
    } catch (reason) {
      notify(
        "danger",
        "Pyth API key rejected",
        reason instanceof Error ? reason.message : "The local server rejected the credential."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel sol-price-bootstrap-panel">
      <SectionHeader
        eyebrow="Historical price coverage"
        title="SOL/USD history bootstrap"
        description="Optional rolling backfill for self-hosted research. Each stale refresh requires explicit authorization. Authenticated Pyth is preferred; managed PAPER setups can use strictly validated Birdeye OHLCV fallback evidence. It cannot trade or bypass promotion."
        action={<span className={`bootstrap-phase bootstrap-${status.phase.toLowerCase()}`}>
          <StatusDot ok={phaseTone(status)} />{titleCase(status.phase)}
        </span>}
      />

      <div className="bootstrap-progress-heading">
        <div><strong>{count(status.completedPoints)}</strong><span>of {count(status.totalPoints)} frozen points</span></div>
        <span>{percent(progress, 1)}</span>
      </div>
      <div className="bootstrap-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="bootstrap-metrics">
        <article><span>Inserted</span><strong>{count(status.insertedSnapshots)}</strong><small>Provider-proven empty timestamps</small></article>
        <article><span>Preserved</span><strong>{count(status.preservedSnapshots)}</strong><small>Existing sources not overwritten</small></article>
        <article><span>Remaining</span><strong>{count(status.remainingPoints)}</strong><small>Ten-minute grid points</small></article>
        <article><span>History source</span><strong>{status.activeSource === "birdeye_ohlcv_v3" ? "Birdeye fallback" : status.activeSource === "pyth_benchmarks" && (status.pythAuthenticationConfigured ?? status.authenticationConfigured) ? "Pyth" : "Not configured"}</strong><small>{status.pythAuthenticationConfigured ? "Pyth bearer configured" : status.managedFallbackConfigured ? "Managed credential configured" : "No provider credential"}</small></article>
      </div>

      <div className={`bootstrap-note ${status.phase === "FAILED" || !status.checkpointValid ? "bootstrap-note-error" : ""}`}>
        <strong>{phaseDescription(status)}</strong>
        {status.windowStartAt && status.windowEndAt && <span>Active generation: {dateTime(status.windowStartAt)} to {dateTime(status.windowEndAt)}</span>}
        {status.currentWindowEndAt && status.windowLagSeconds !== undefined && <span>Rolling target: {dateTime(status.currentWindowEndAt)} · lag {count(Math.floor(status.windowLagSeconds / 60))} min</span>}
        {status.nextTimestampAt && <span>Next point: {dateTime(status.nextTimestampAt)}</span>}
        {status.nextRetryAt && <span>Retry at: {dateTime(status.nextRetryAt)} · attempt {status.cursorAttempts}</span>}
        {status.lastError && <span>{status.lastError}</span>}
      </div>

      <div className="bootstrap-actions">
        <Button
          tone="ghost"
          icon="key"
          disabled={!canChangeKey}
          title={canChangeKey ? "Validate and encrypt a Pyth Benchmarks bearer key" : "The key can be changed only in SETUP or PAPER"}
          onClick={() => {
            setPythApiKey("");
            setKeyConfirmation("");
            setKeyModalOpen(true);
          }}
        >
          {pythConfigured ? "Replace Pyth key" : "Configure Pyth key"}
        </Button>
        {canPause && <Button tone="secondary" icon="pause" onClick={() => openAction("pause")}>Pause bootstrap</Button>}
        {!canPause && (status.phase !== "COMPLETE" || status.refreshAvailable) && <Button
          tone="primary"
          icon="play"
          disabled={!canStart}
          title={canStart ? "Explicitly start, resume, or refresh the historical backfill" : "Start is allowed only in SETUP or PAPER with a valid cursor"}
          onClick={() => openAction("start")}
        >
          {solPriceBootstrapStartLabel(status)}
        </Button>}
      </div>

      <Modal
        open={action !== null}
        onClose={closeAction}
        title={action === "pause" ? "Pause the history bootstrap?" : `${solPriceBootstrapStartLabel(status)}?`}
        description={action === "pause"
          ? "The current cursor will remain durable. No grid point is skipped."
          : "This starts a long-running, rate-limited historical download. It does not enable SELF_HOSTED or live trading."}
      >
        <div className="confirmation-box confirmation-neutral">
          <p>Type <code>{expected}</code> to confirm.</p>
          <input
            autoFocus
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value.toUpperCase())}
            placeholder={expected}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="modal-actions">
          <Button tone="ghost" disabled={busy} onClick={closeAction}>Cancel</Button>
          <Button tone={action === "pause" ? "secondary" : "primary"} busy={busy} disabled={confirmation !== expected} onClick={() => void submit()}>
            {action === "pause" ? "Pause safely" : solPriceBootstrapStartLabel(status)}
          </Button>
        </div>
      </Modal>

      <Modal
        open={keyModalOpen}
        onClose={closeKeyModal}
        title={pythConfigured ? "Replace the Pyth API key?" : "Configure the Pyth API key?"}
        description="The key is validated first, then stored with Windows DPAPI. It is never returned by the API or displayed again."
      >
        <label className="field bootstrap-key-field">
          <span className="field-heading"><span>Pyth Benchmarks API key</span><small>Pyth authentication is mandatory from August 26, 2026 at 16:00 UTC. Birdeye fallback remains separately labeled.</small></span>
          <input
            autoFocus
            type="password"
            value={pythApiKey}
            onChange={(event) => setPythApiKey(event.target.value)}
            placeholder="Paste Pyth bearer key"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="confirmation-box confirmation-neutral">
          <p>Type <code>{SAVE_PYTH_API_KEY_CONFIRMATION}</code> to confirm.</p>
          <input
            value={keyConfirmation}
            onChange={(event) => setKeyConfirmation(event.target.value.toUpperCase())}
            placeholder={SAVE_PYTH_API_KEY_CONFIRMATION}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="modal-actions">
          <Button tone="ghost" disabled={busy} onClick={closeKeyModal}>Cancel</Button>
          <Button
            tone="primary"
            busy={busy}
            disabled={pythApiKey.trim().length < 8 || keyConfirmation !== SAVE_PYTH_API_KEY_CONFIRMATION}
            onClick={() => void submitKey()}
          >
            Validate & encrypt key
          </Button>
        </div>
      </Modal>
    </section>
  );
}
