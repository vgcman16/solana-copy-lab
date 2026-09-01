import type { ModeState, PromotionGate } from "@copylab/shared";

export interface ModeMachineState {
  mode: ModeState;
  pausedFrom?: Exclude<ModeState, "PAUSED" | "LOCKED" | "SETUP">;
}

export type ModeEvent =
  | { type: "SETUP_COMPLETE" }
  | { type: "ENABLE_MANUAL_LIVE"; confirmed: boolean }
  | { type: "ENABLE_AUTO_LIVE"; confirmed: boolean }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "LOCK" }
  | { type: "RESET_TO_PAPER"; reviewAcknowledged: boolean };

export interface ModeTransitionContext {
  promotion: Pick<PromotionGate, "paperPassed" | "manualLivePassed">;
}

export class ModeTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeTransitionError";
  }
}

function assertResumeGate(
  target: Exclude<ModeState, "PAUSED" | "LOCKED" | "SETUP">,
  context: ModeTransitionContext
): void {
  if (target === "MANUAL_LIVE" && !context.promotion.paperPassed) {
    throw new ModeTransitionError("paper promotion gate no longer passes");
  }
  if (target === "AUTO_LIVE" && !context.promotion.manualLivePassed) {
    throw new ModeTransitionError("manual-live promotion gate no longer passes");
  }
}

/** Pure, explicit state transition. There is no transition that silently promotes live modes. */
export function transitionMode(
  state: Readonly<ModeMachineState>,
  event: ModeEvent,
  context: ModeTransitionContext
): ModeMachineState {
  if (event.type === "LOCK") return { mode: "LOCKED" };

  switch (event.type) {
    case "SETUP_COMPLETE":
      if (state.mode !== "SETUP") throw new ModeTransitionError("setup can only complete from SETUP");
      return { mode: "PAPER" };

    case "ENABLE_MANUAL_LIVE":
      if (state.mode !== "PAPER") throw new ModeTransitionError("manual live can only start from PAPER");
      if (!event.confirmed) throw new ModeTransitionError("manual live requires explicit confirmation");
      if (!context.promotion.paperPassed) throw new ModeTransitionError("paper promotion gate has not passed");
      return { mode: "MANUAL_LIVE" };

    case "ENABLE_AUTO_LIVE":
      if (state.mode !== "MANUAL_LIVE") {
        throw new ModeTransitionError("auto live can only start from MANUAL_LIVE");
      }
      if (!event.confirmed) throw new ModeTransitionError("auto live requires explicit confirmation");
      if (!context.promotion.manualLivePassed) {
        throw new ModeTransitionError("manual-live promotion gate has not passed");
      }
      return { mode: "AUTO_LIVE" };

    case "PAUSE": {
      if (state.mode !== "PAPER" && state.mode !== "MANUAL_LIVE" && state.mode !== "AUTO_LIVE") {
        throw new ModeTransitionError(`cannot pause from ${state.mode}`);
      }
      return { mode: "PAUSED", pausedFrom: state.mode };
    }

    case "RESUME": {
      if (state.mode !== "PAUSED" || !state.pausedFrom) {
        throw new ModeTransitionError("only a paused mode can resume");
      }
      assertResumeGate(state.pausedFrom, context);
      return { mode: state.pausedFrom };
    }

    case "RESET_TO_PAPER":
      if (state.mode !== "LOCKED") throw new ModeTransitionError("only LOCKED can reset to paper");
      if (!event.reviewAcknowledged) {
        throw new ModeTransitionError("locked mode requires an acknowledged review");
      }
      return { mode: "PAPER" };
  }
}

export class ModeStateMachine {
  #state: ModeMachineState;

  constructor(initial: ModeMachineState = { mode: "SETUP" }) {
    this.#state = { ...initial };
  }

  get state(): Readonly<ModeMachineState> {
    return { ...this.#state };
  }

  dispatch(event: ModeEvent, context: ModeTransitionContext): Readonly<ModeMachineState> {
    this.#state = transitionMode(this.#state, event, context);
    return this.state;
  }
}
