import type { ModeState, PromotionGate } from "@copylab/shared";
import { transitionMode as transitionCoreMode, type ModeEvent } from "@copylab/core";
import type { Repository } from "./repository.js";
import type { WalletManager } from "./wallet.js";

const INITIAL_PROMOTION: PromotionGate = {
  evaluatedAt: new Date(0).toISOString(),
  elapsedDays: 0,
  completedExits: 0,
  netReturnPercent: 0,
  profitFactor: 0,
  maxDrawdownPercent: 0,
  positiveWeeks: 0,
  largestTradeProfitShare: 0,
  topThreeProfitShare: 0,
  stressNetReturnPercent: 0,
  stressMaxDrawdownPercent: 0,
  qualifyingWallets: 0,
  manualLiveOrders: 0,
  manualCompletedPositions: 0,
  paperShortfallP95Percent: 0,
  manualWorstShortfallPercent: 0,
  manualPolicyViolations: 0,
  paperPassed: false,
  manualLivePassed: false,
  blockers: ["Paper evaluation has not completed."]
};

export class ModeManager {
  constructor(
    private readonly repository: Repository,
    private readonly wallet: WalletManager
  ) {}

  get mode(): ModeState {
    return this.repository.getSetting<ModeState>("mode") ?? "SETUP";
  }

  get pausedFrom(): ModeState | undefined {
    return this.repository.getSetting<ModeState>("paused_from");
  }

  get promotion(): PromotionGate {
    return this.repository.getSetting<PromotionGate>("promotion_gate") ?? INITIAL_PROMOTION;
  }

  setPromotion(gate: PromotionGate): void {
    this.repository.setSetting("promotion_gate", gate);
  }

  transition(target: ModeState, options: { confirmed?: boolean; reviewAcknowledged?: boolean } = {}): ModeState {
    const current = this.mode;
    if (current === target) return current;
    if (current === "LOCKED" && target !== "PAPER") throw new Error("Live mode is locked after a hard stop.");

    if (current === "SETUP" && target === "PAPER") {
      if (!this.repository.hasSecret("provider-credentials")) throw new Error("Provider credentials are required.");
      if (!this.repository.getSetting<string>("paper_start_at")) throw new Error("Paper portfolio is not initialized.");
    }
    if (current === "PAPER" && target === "MANUAL_LIVE") {
      const wallet = this.wallet.status();
      if (!wallet.exists || !wallet.backupConfirmed) {
        throw new Error("A dedicated wallet and confirmed encrypted recovery backup are required.");
      }
    }

    const pausedFrom = this.pausedFrom;
    const event: ModeEvent =
      target === "PAUSED"
        ? { type: "PAUSE" }
        : current === "PAUSED" && pausedFrom === target
          ? { type: "RESUME" }
          : current === "LOCKED" && target === "PAPER"
            ? { type: "RESET_TO_PAPER", reviewAcknowledged: options.reviewAcknowledged === true }
          : current === "SETUP" && target === "PAPER"
            ? { type: "SETUP_COMPLETE" }
            : current === "PAPER" && target === "MANUAL_LIVE"
              ? { type: "ENABLE_MANUAL_LIVE", confirmed: options.confirmed === true }
              : current === "MANUAL_LIVE" && target === "AUTO_LIVE"
                ? { type: "ENABLE_AUTO_LIVE", confirmed: options.confirmed === true }
                : (() => { throw new Error(`Unsafe mode transition: ${current} -> ${target}`); })();
    const next = transitionCoreMode(
      {
        mode: current,
        ...(current === "PAUSED" && pausedFrom && ["PAPER", "MANUAL_LIVE", "AUTO_LIVE"].includes(pausedFrom)
          ? { pausedFrom: pausedFrom as "PAPER" | "MANUAL_LIVE" | "AUTO_LIVE" }
          : {})
      },
      event,
      { promotion: this.promotion }
    );
    this.repository.db.transaction(() => {
      this.repository.setSetting("mode", next.mode);
      this.repository.setSetting("paused_from", next.pausedFrom ?? null);
      if (event.type === "PAUSE") {
        this.repository.audit("mode_paused", `Copying paused from ${current}.`, { current });
      } else if (event.type === "RESUME") {
        this.repository.audit("mode_resumed", `Copying resumed in ${next.mode}.`, { target: next.mode });
      } else {
        this.repository.audit("mode_transition", `Mode changed from ${current} to ${next.mode}.`, {
          current,
          target: next.mode
        });
      }
    })();
    return next.mode;
  }

  /**
   * Fails closed after the durable live transition has been written but the
   * runtime could not finish activating it. The PAUSED state, resume target,
   * and critical audit record are one SQLite transaction so a later operator
   * review sees the exact live mode that must be re-preflighted.
   */
  pauseFailedLiveActivation(
    intendedMode: "MANUAL_LIVE" | "AUTO_LIVE",
    failure: string
  ): void {
    this.repository.db.transaction(() => {
      this.repository.setSetting("mode", "PAUSED");
      this.repository.setSetting("paused_from", intendedMode);
      this.repository.audit(
        "live_mode_activation_failed",
        `Runtime activation of ${intendedMode} failed; signing was forced to PAUSED.`,
        { intendedMode, failure },
        "critical"
      );
    })();
  }

  lock(reason: string): void {
    this.repository.setSetting("mode", "LOCKED");
    this.repository.setSetting("lock_reason", reason);
    this.repository.audit("mode_locked", reason, undefined, "critical");
  }
}
