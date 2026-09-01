import { useEffect, useMemo, useState } from "react";
import { DEFAULT_RISK_POLICY } from "@copylab/shared";
import { initializePaper, saveCredentials } from "../api";
import { money, titleCase } from "../format";
import type { CredentialsInput, SetupStatus } from "../types";
import { Brand, Button, StatusDot } from "./Primitives";
import { Icon } from "./Icon";

interface SetupWizardProps {
  csrfToken: string;
  status: SetupStatus;
  onRefresh: () => Promise<SetupStatus>;
  onComplete: () => Promise<void>;
}

const EMPTY_CREDENTIALS: CredentialsInput = {
  birdeyeApiKey: "",
  heliusApiKey: "",
  jupiterApiKey: "",
  pythBenchmarksApiKey: ""
};

const STEPS = ["Welcome", "Providers", "Paper capital", "Ready"] as const;
const INITIAL_NAV_USD = DEFAULT_RISK_POLICY.initialNavUsd;

export function SetupWizard({ csrfToken, status, onRefresh, onComplete }: SetupWizardProps) {
  const initialStep = status.paperConfigured ? 3 : status.credentialsConfigured ? 2 : 0;
  const [step, setStep] = useState(initialStep);
  const [credentials, setCredentials] = useState<CredentialsInput>(EMPTY_CREDENTIALS);
  const [capital, setCapital] = useState(String(status.paperCapitalUsd ?? INITIAL_NAV_USD));
  const [showKeys, setShowKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestStatus, setLatestStatus] = useState(status);

  useEffect(() => setLatestStatus(status), [status]);

  const credentialsReady = useMemo(
    () => credentials.birdeyeApiKey.trim().length >= 8
      && credentials.heliusApiKey.trim().length >= 8
      && credentials.jupiterApiKey.trim().length >= 8
      && (
        (credentials.pythBenchmarksApiKey ?? "").trim().length === 0
        || (credentials.pythBenchmarksApiKey ?? "").trim().length >= 8
      ),
    [credentials]
  );
  const capitalNumber = Number(capital);
  const capitalReady = capitalNumber === INITIAL_NAV_USD;

  async function submitCredentials(event: React.FormEvent) {
    event.preventDefault();
    if (!credentialsReady) return;
    setBusy(true);
    setError(null);
    try {
      const pythBenchmarksApiKey = credentials.pythBenchmarksApiKey?.trim();
      const health = await saveCredentials({
        birdeyeApiKey: credentials.birdeyeApiKey.trim(),
        heliusApiKey: credentials.heliusApiKey.trim(),
        jupiterApiKey: credentials.jupiterApiKey.trim(),
        ...(pythBenchmarksApiKey ? { pythBenchmarksApiKey } : {})
      }, csrfToken);
      setCredentials(EMPTY_CREDENTIALS);
      const refreshed = await onRefresh();
      setLatestStatus(health.length > 0 ? { ...refreshed, providers: health } : refreshed);
      setStep(2);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider setup failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCapital(event: React.FormEvent) {
    event.preventDefault();
    if (!capitalReady) return;
    setBusy(true);
    setError(null);
    try {
      await initializePaper(capitalNumber, csrfToken);
      const refreshed = await onRefresh();
      setLatestStatus(refreshed);
      setStep(3);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Paper account setup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="setup-shell">
      <div className="setup-ambient setup-ambient-one" />
      <div className="setup-ambient setup-ambient-two" />
      <nav className="setup-nav"><Brand /></nav>

      <section className="setup-card">
        <aside className="setup-sidebar">
          <div>
            <p className="eyebrow">Local setup</p>
            <h1>Your copy lab,<br />under control.</h1>
            <p>Research profitable wallets and test every idea in a guarded {money(INITIAL_NAV_USD)} paper account before live funds are ever enabled.</p>
          </div>

          <ol className="setup-steps">
            {STEPS.map((label, index) => (
              <li key={label} className={index === step ? "active" : index < step ? "complete" : ""}>
                <span>{index < step ? <Icon name="check" size={14} /> : index + 1}</span>
                <div><strong>{label}</strong><small>{index === 0 ? "Know the guardrails" : index === 1 ? "Connect free APIs" : index === 2 ? "Choose simulated NAV" : "Start observing"}</small></div>
              </li>
            ))}
          </ol>

          <div className="local-only-note"><Icon name="lock" size={15} /><span>Runs on this PC at <code>127.0.0.1</code></span></div>
        </aside>

        <div className="setup-content">
          {step === 0 && (
            <div className="wizard-panel wizard-welcome">
              <span className="wizard-icon"><Icon name="shield" size={27} /></span>
              <p className="eyebrow">Before we begin</p>
              <h2>This starts in paper mode.</h2>
              <p className="wizard-lead">CopyLab observes real Solana trades but simulates the copies. Live trading stays locked behind 30 days of forward results, 50 exits, and your explicit approval.</p>
              <div className="guardrail-list">
                <div><Icon name="check" size={17} /><span><strong>No primary wallet seed.</strong> A dedicated bot wallet is created only during live onboarding.</span></div>
                <div><Icon name="check" size={17} /><span><strong>No blind copying.</strong> Every token, quote, cost, and concentration rule is checked first.</span></div>
                <div><Icon name="check" size={17} /><span><strong>Hard stops included.</strong> Drawdown, daily loss, provider health, and balance checks can pause the system.</span></div>
              </div>
              <Button tone="primary" icon="arrow" onClick={() => setStep(latestStatus.credentialsConfigured ? 2 : 1)}>Set up providers</Button>
              <p className="risk-disclosure">This is experimental software, not a profit guarantee. Crypto assets can lose all of their value.</p>
            </div>
          )}

          {step === 1 && (
            <form className="wizard-panel" onSubmit={(event) => void submitCredentials(event)}>
              <p className="eyebrow">Step 1 of 2</p>
              <h2>Connect the data providers.</h2>
              <p className="wizard-lead">Use separate free-tier API keys. They are sent only to the local server and stored with Windows encryption.</p>

              <div className="key-fields">
                {([
                  ["birdeyeApiKey", "Birdeye", "Wallet discovery and P&L rankings", false],
                  ["heliusApiKey", "Helius", "Confirmed Solana transaction monitoring", false],
                  ["jupiterApiKey", "Jupiter", "Token checks, quotes, and later execution", false],
                  ["pythBenchmarksApiKey", "Pyth Benchmarks", "Optional preferred SOL/USD source; Pyth requires a key from August 26, 2026 at 16:00 UTC", true]
                ] as const).map(([key, label, helper, optional]) => (
                  <label className="field" key={key}>
                    <span className="field-heading"><span>{label} API key{optional ? " (optional)" : ""}</span><small>{helper}</small></span>
                    <span className="input-wrap"><Icon name="key" size={16} /><input
                      type={showKeys ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      value={credentials[key] ?? ""}
                      onChange={(event) => setCredentials((current) => ({ ...current, [key]: event.target.value }))}
                      placeholder={`Paste ${label} key`}
                      required={!optional}
                    /></span>
                  </label>
                ))}
              </div>

              <label className="check-row"><input type="checkbox" checked={showKeys} onChange={(event) => setShowKeys(event.target.checked)} /><span>Show keys while typing</span></label>
              {error && <div className="inline-error"><Icon name="alert" size={17} />{error}</div>}
              <div className="wizard-actions"><Button tone="ghost" type="button" onClick={() => setStep(0)}>Back</Button><Button tone="primary" type="submit" busy={busy} disabled={!credentialsReady}>Save & test connections</Button></div>
            </form>
          )}

          {step === 2 && (
            <form className="wizard-panel" onSubmit={(event) => void submitCapital(event)}>
              <p className="eyebrow">Step 2 of 2</p>
              <h2>Set the paper bankroll.</h2>
              <p className="wizard-lead">This is simulated capital only. Starting with the same amount you may eventually fund makes the copy results more honest.</p>

              {latestStatus.providers.length > 0 && (
                <div className="setup-provider-strip">
                  {latestStatus.providers.map((provider) => <div key={provider.provider}><StatusDot ok={provider.ok} /><span>{titleCase(provider.provider)}</span><small>{provider.ok ? "Connected" : provider.message}</small></div>)}
                </div>
              )}

              <label className="capital-field">
                <span>Starting paper NAV</span>
                <div><b>$</b><input type="number" min={INITIAL_NAV_USD} max={INITIAL_NAV_USD} step="1" value={capital} onChange={(event) => setCapital(event.target.value)} readOnly /></div>
                <small>This run uses a fixed {money(INITIAL_NAV_USD)} paper NAV so every wallet is compared on the same footing.</small>
              </label>

              <div className="allocation-preview">
                <p><span>SOL reserve + fee buffer</span><strong>{money(Math.min(DEFAULT_RISK_POLICY.initialSolAllocationUsd, capitalNumber || 0))}</strong></p>
                <p><span>Simulated USDC</span><strong>{money(Math.max(0, (capitalNumber || 0) - DEFAULT_RISK_POLICY.initialSolAllocationUsd))}</strong></p>
                <p><span>Maximum first position</span><strong>{money(Math.min(DEFAULT_RISK_POLICY.maxPositionUsd, (capitalNumber || 0) * DEFAULT_RISK_POLICY.positionNavFraction))}</strong></p>
              </div>
              {error && <div className="inline-error"><Icon name="alert" size={17} />{error}</div>}
              <div className="wizard-actions"><Button tone="ghost" type="button" onClick={() => setStep(1)}>Back</Button><Button tone="primary" type="submit" busy={busy} disabled={!capitalReady}>Initialize paper account</Button></div>
            </form>
          )}

          {step === 3 && (
            <div className="wizard-panel wizard-ready">
              <span className="ready-ring"><Icon name="check" size={30} /></span>
              <p className="eyebrow">Setup complete</p>
              <h2>The lab is ready.</h2>
              <p className="wizard-lead">CopyLab can now discover a wallet cohort and record forward copy results. No real transaction can be signed in paper mode.</p>
              <div className="ready-summary">
                <div><span>Mode</span><strong>PAPER</strong></div>
                <div><span>Starting NAV</span><strong>{money(latestStatus.paperCapitalUsd ?? capitalNumber)}</strong></div>
                <div><span>Live signing</span><strong>Locked</strong></div>
              </div>
              <Button tone="primary" icon="arrow" busy={busy} onClick={() => {
                setBusy(true);
                void onComplete().finally(() => setBusy(false));
              }}>Open dashboard</Button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
