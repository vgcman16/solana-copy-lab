import { useEffect, useState } from "react";
import type { AlpacaPaperStatus, ModeState } from "@copylab/shared";
import {
  getAlpacaPaperStatus,
  saveAlpacaPaperCredentials
} from "../api";
import { count, relativeTime } from "../format";
import type { ToastTone } from "../types";
import { Button, Modal, SectionHeader, StatusDot } from "./Primitives";

const CONFIRMATION = "CONNECT ALPACA PAPER" as const;

interface AlpacaPaperSetupCardProps {
  appMode: ModeState;
  csrfToken: string;
  notify: (tone: ToastTone, title: string, detail?: string) => void;
}

export function AlpacaPaperSetupCard({
  appMode,
  csrfToken,
  notify
}: AlpacaPaperSetupCardProps) {
  const [status, setStatus] = useState<AlpacaPaperStatus>();
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const canConfigure = appMode === "SETUP" || appMode === "PAPER";

  useEffect(() => {
    const controller = new AbortController();
    void getAlpacaPaperStatus(controller.signal)
      .then(setStatus)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          notify(
            "danger",
            "Alpaca Paper status unavailable",
            reason instanceof Error ? reason.message : "The status request failed."
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [notify]);

  function closeModal() {
    if (busy) return;
    setApiKey("");
    setSecretKey("");
    setConfirmation("");
    setModalOpen(false);
  }

  async function submit() {
    const nextApiKey = apiKey.trim();
    const nextSecretKey = secretKey.trim();
    if (
      !canConfigure ||
      nextApiKey.length < 8 ||
      nextSecretKey.length < 8 ||
      confirmation !== CONFIRMATION
    ) return;
    setBusy(true);
    setApiKey("");
    setSecretKey("");
    setConfirmation("");
    try {
      const connected = await saveAlpacaPaperCredentials({
        apiKey: nextApiKey,
        secretKey: nextSecretKey,
        confirmation: CONFIRMATION
      }, csrfToken);
      setStatus(connected);
      setModalOpen(false);
      notify(
        "success",
        "Alpaca Paper connected",
        "The replacement credentials were validated and encrypted for this Windows account."
      );
    } catch (reason) {
      notify(
        "danger",
        "Alpaca Paper connection rejected",
        reason instanceof Error ? reason.message : "The credential was not saved."
      );
    } finally {
      setBusy(false);
    }
  }

  const connectionTone = loading ? "warning" : status?.connected ? true : status?.configured ? false : "warning";

  return (
    <section className="panel alpaca-paper-panel">
      <SectionHeader
        eyebrow="Optional US-stock research"
        title="Alpaca Paper"
        description="A separate free stock-paper connection using IEX data. It cannot place live stock orders and does not affect the Solana providers or bankroll."
        action={<span className="alpaca-paper-status">
          <StatusDot ok={connectionTone} />
          {loading ? "Checking" : status?.connected ? "Connected" : status?.configured ? "Needs attention" : "Not connected"}
        </span>}
      />

      <div className="alpaca-paper-grid">
        <article><span>Trading endpoint</span><strong>Paper only</strong><small>paper-api.alpaca.markets</small></article>
        <article><span>Market data</span><strong>Free IEX</strong><small>Isolated stock research feed</small></article>
        <article><span>Live-order capability</span><strong>Disabled</strong><small>No real stock orders in this integration</small></article>
        <article><span>Credential storage</span><strong>Windows DPAPI</strong><small>The keys are never displayed again</small></article>
      </div>

      <div className="alpaca-paper-note">
        <div>
          <strong>{status?.message ?? "Reading the isolated provider status."}</strong>
          <span>{status?.accountStatus ? `Paper account: ${status.accountStatus}` : "Use a newly rotated key pair, not the pair visible in the screenshot."}</span>
        </div>
        <div className="alpaca-paper-meta">
          {status?.latencyMs !== undefined && <span>{count(status.latencyMs)} ms</span>}
          {status?.checkedAt && <span>{relativeTime(status.checkedAt)}</span>}
        </div>
      </div>

      <div className="alpaca-paper-actions">
        <p>Private Tailscale access remains read-only except for this exact credential form.</p>
        <Button
          tone="primary"
          icon="key"
          disabled={!canConfigure}
          title={canConfigure ? "Validate and encrypt Alpaca Paper credentials" : "Allowed only in SETUP or PAPER"}
          onClick={() => {
            setApiKey("");
            setSecretKey("");
            setConfirmation("");
            setModalOpen(true);
          }}
        >
          {status?.configured ? "Replace paper keys" : "Connect Alpaca Paper"}
        </Button>
      </div>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={status?.configured ? "Replace the Alpaca Paper keys?" : "Connect Alpaca Paper?"}
        description="Enter a newly generated paper key pair. CopyLab validates the fixed paper-trading endpoint and free IEX feed before encrypting anything."
      >
        <div className="alpaca-paper-secret-fields">
          <label className="field">
            <span className="field-heading"><span>Paper API key</span><small>Never use a live-account key</small></span>
            <input
              autoFocus
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Paste replacement paper API key"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-heading"><span>Paper secret key</span><small>Cleared from the form immediately</small></span>
            <input
              type="password"
              value={secretKey}
              onChange={(event) => setSecretKey(event.target.value)}
              placeholder="Paste replacement paper secret"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        <div className="confirmation-box confirmation-neutral">
          <p>Type <code>{CONFIRMATION}</code> to confirm.</p>
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value.toUpperCase())}
            placeholder={CONFIRMATION}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="modal-actions">
          <Button tone="ghost" disabled={busy} onClick={closeModal}>Cancel</Button>
          <Button
            tone="primary"
            busy={busy}
            disabled={apiKey.trim().length < 8 || secretKey.trim().length < 8 || confirmation !== CONFIRMATION}
            onClick={() => void submit()}
          >
            Validate & encrypt
          </Button>
        </div>
      </Modal>
    </section>
  );
}
