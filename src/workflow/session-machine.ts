import type { SessionState } from "@/src/domain/session";

export const SessionEvent = {
  SAVE_PREFERENCES: "SAVE_PREFERENCES",
  RECOGNIZE_INGREDIENTS: "RECOGNIZE_INGREDIENTS",
  CONFIRM_INGREDIENTS: "CONFIRM_INGREDIENTS",
  GENERATE_RECIPE_SET: "GENERATE_RECIPE_SET",
  SELECT_RECIPE: "SELECT_RECIPE",
  ADVANCE_MIXING: "ADVANCE_MIXING",
  BACK_MIXING: "BACK_MIXING",
  SUBMIT_FEEDBACK: "SUBMIT_FEEDBACK",
  ACCEPT_ADJUSTMENT: "ACCEPT_ADJUSTMENT",
  COMPLETE_SESSION: "COMPLETE_SESSION",
} as const;

export type SessionEvent = (typeof SessionEvent)[keyof typeof SessionEvent];

export interface TransitionContext {
  hasPreferences: boolean;
  hasOverviewImage: boolean;
  allIngredientsConfirmed: boolean;
  alcoholAbvConfirmed: boolean;
  hasRecipeSet: boolean;
  hasSelectedRecipe: boolean;
  hasSelectedAdjustedRecipe: boolean;
  currentStep: number | null;
  totalSteps: number | null;
  hasFeedback: boolean;
}

export const INVALID_TRANSITION = "INVALID_TRANSITION" as const;

export class SessionTransitionError extends Error {
  readonly code = INVALID_TRANSITION;
  readonly from: SessionState;
  readonly event: SessionEvent;

  constructor(from: SessionState, event: SessionEvent) {
    super(`${INVALID_TRANSITION}: ${from} -> ${event}`);
    this.name = "SessionTransitionError";
    this.from = from;
    this.event = event;
  }
}

type TransitionTarget = SessionState | ((context: TransitionContext) => SessionState);

interface TransitionRule {
  event: SessionEvent;
  target: TransitionTarget;
  guard: (context: TransitionContext) => boolean;
}

const hasValidMixingStep = ({ currentStep, totalSteps }: TransitionContext): boolean =>
  Number.isInteger(currentStep) &&
  Number.isInteger(totalSteps) &&
  currentStep !== null &&
  totalSteps !== null &&
  totalSteps > 0 &&
  currentStep >= 0 &&
  currentStep < totalSteps;

const hasReadyInput = (context: TransitionContext): boolean =>
  context.hasPreferences &&
  context.hasOverviewImage &&
  context.allIngredientsConfirmed &&
  context.alcoholAbvConfirmed;

const canAdvanceMixing = (context: TransitionContext): boolean => hasValidMixingStep(context);

const canGoBackInMixing = (context: TransitionContext): boolean =>
  hasValidMixingStep(context) && context.currentStep !== null && context.currentStep > 0;

const advanceMixingTarget = ({ currentStep, totalSteps }: TransitionContext): SessionState => {
  if (currentStep === null || totalSteps === null) {
    return "MIXING";
  }

  return currentStep === totalSteps - 1 ? "FEEDBACK" : "MIXING";
};

const transitionTable: Record<SessionState, readonly TransitionRule[]> = {
  PREFERENCES: [
    {
      event: SessionEvent.SAVE_PREFERENCES,
      target: "SCAN",
      guard: (context) => context.hasPreferences,
    },
  ],
  SCAN: [
    {
      event: SessionEvent.RECOGNIZE_INGREDIENTS,
      target: "CONFIRM",
      guard: (context) => context.hasPreferences && context.hasOverviewImage,
    },
  ],
  CONFIRM: [
    {
      event: SessionEvent.CONFIRM_INGREDIENTS,
      target: "READY",
      guard: (context) => context.allIngredientsConfirmed && context.alcoholAbvConfirmed,
    },
  ],
  READY: [
    {
      event: SessionEvent.GENERATE_RECIPE_SET,
      target: "RECIPE_SELECTION",
      guard: hasReadyInput,
    },
  ],
  RECIPE_SELECTION: [
    {
      event: SessionEvent.GENERATE_RECIPE_SET,
      target: "RECIPE_SELECTION",
      guard: hasReadyInput,
    },
    {
      event: SessionEvent.SELECT_RECIPE,
      target: "MIXING",
      guard: (context) => context.hasRecipeSet && context.hasSelectedRecipe,
    },
  ],
  MIXING: [
    {
      event: SessionEvent.ADVANCE_MIXING,
      target: advanceMixingTarget,
      guard: canAdvanceMixing,
    },
    {
      event: SessionEvent.BACK_MIXING,
      target: "MIXING",
      guard: canGoBackInMixing,
    },
  ],
  FEEDBACK: [
    {
      event: SessionEvent.SUBMIT_FEEDBACK,
      target: "ADJUSTMENT",
      guard: (context) => context.hasFeedback,
    },
    {
      event: SessionEvent.COMPLETE_SESSION,
      target: "COMPLETED",
      guard: (context) => context.hasFeedback,
    },
  ],
  ADJUSTMENT: [
    {
      event: SessionEvent.ACCEPT_ADJUSTMENT,
      target: "MIXING",
      guard: (context) =>
        context.hasFeedback && context.hasSelectedRecipe && context.hasSelectedAdjustedRecipe,
    },
    {
      event: SessionEvent.COMPLETE_SESSION,
      target: "COMPLETED",
      guard: (context) => context.hasFeedback,
    },
  ],
  COMPLETED: [],
};

export function transition(
  from: SessionState,
  event: SessionEvent,
  context: TransitionContext,
): SessionState {
  const rule = transitionTable[from]?.find((candidate) => candidate.event === event);

  if (rule === undefined || !rule.guard(context)) {
    throw new SessionTransitionError(from, event);
  }

  return typeof rule.target === "function" ? rule.target(context) : rule.target;
}
