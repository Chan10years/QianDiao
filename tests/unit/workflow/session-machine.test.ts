import { describe, expect, it } from "vitest";

import type { SessionState } from "@/src/domain/session";
import { SessionEvent, type TransitionContext, transition } from "@/src/workflow/session-machine";

const context = (overrides: Partial<TransitionContext> = {}): TransitionContext => ({
  hasPreferences: true,
  hasOverviewImage: true,
  allIngredientsConfirmed: true,
  alcoholAbvConfirmed: true,
  hasRecipeSet: true,
  hasSelectedRecipe: true,
  hasSelectedAdjustedRecipe: false,
  currentStep: null,
  totalSteps: null,
  hasFeedback: true,
  ...overrides,
});

describe("session machine legal transitions", () => {
  const cases: Array<{
    from: SessionState;
    event: SessionEvent;
    context: TransitionContext;
    expected: SessionState;
  }> = [
    {
      from: "PREFERENCES",
      event: SessionEvent.SAVE_PREFERENCES,
      context: context(),
      expected: "SCAN",
    },
    {
      from: "SCAN",
      event: SessionEvent.RECOGNIZE_INGREDIENTS,
      context: context(),
      expected: "CONFIRM",
    },
    {
      from: "CONFIRM",
      event: SessionEvent.CONFIRM_INGREDIENTS,
      context: context(),
      expected: "READY",
    },
    {
      from: "READY",
      event: SessionEvent.GENERATE_RECIPE_SET,
      context: context({ hasRecipeSet: false, hasSelectedRecipe: false }),
      expected: "RECIPE_SELECTION",
    },
    {
      from: "RECIPE_SELECTION",
      event: SessionEvent.SELECT_RECIPE,
      context: context(),
      expected: "MIXING",
    },
    {
      from: "MIXING",
      event: SessionEvent.ADVANCE_MIXING,
      context: context({ currentStep: 0, totalSteps: 3 }),
      expected: "MIXING",
    },
    {
      from: "MIXING",
      event: SessionEvent.BACK_MIXING,
      context: context({ currentStep: 1, totalSteps: 3 }),
      expected: "MIXING",
    },
    {
      from: "MIXING",
      event: SessionEvent.ADVANCE_MIXING,
      context: context({ currentStep: 2, totalSteps: 3 }),
      expected: "FEEDBACK",
    },
    {
      from: "FEEDBACK",
      event: SessionEvent.SUBMIT_FEEDBACK,
      context: context(),
      expected: "ADJUSTMENT",
    },
    {
      from: "FEEDBACK",
      event: SessionEvent.COMPLETE_SESSION,
      context: context(),
      expected: "COMPLETED",
    },
    {
      from: "ADJUSTMENT",
      event: SessionEvent.ACCEPT_ADJUSTMENT,
      context: context({ hasSelectedAdjustedRecipe: true }),
      expected: "MIXING",
    },
    {
      from: "ADJUSTMENT",
      event: SessionEvent.COMPLETE_SESSION,
      context: context(),
      expected: "COMPLETED",
    },
  ];

  it.each(cases)(
    "moves $from with $event to $expected",
    ({ from, event, context: transitionContext, expected }) => {
      expect(transition(from, event, transitionContext)).toBe(expected);
    },
  );
});

describe("session machine guards", () => {
  it("requires preferences before leaving PREFERENCES", () => {
    expect(() =>
      transition("PREFERENCES", SessionEvent.SAVE_PREFERENCES, context({ hasPreferences: false })),
    ).toThrowError(/INVALID_TRANSITION.*PREFERENCES.*SAVE_PREFERENCES/);
  });

  it("requires an overview image before recognition leaves SCAN", () => {
    expect(() =>
      transition("SCAN", SessionEvent.RECOGNIZE_INGREDIENTS, context({ hasOverviewImage: false })),
    ).toThrowError(/INVALID_TRANSITION.*SCAN.*RECOGNIZE_INGREDIENTS/);
  });

  it("requires confirmed ingredients and a confirmed ABV before READY", () => {
    expect(() =>
      transition(
        "CONFIRM",
        SessionEvent.CONFIRM_INGREDIENTS,
        context({ allIngredientsConfirmed: false }),
      ),
    ).toThrowError(/INVALID_TRANSITION.*CONFIRM.*CONFIRM_INGREDIENTS/);

    expect(() =>
      transition(
        "CONFIRM",
        SessionEvent.CONFIRM_INGREDIENTS,
        context({ alcoholAbvConfirmed: false }),
      ),
    ).toThrowError(/INVALID_TRANSITION.*CONFIRM.*CONFIRM_INGREDIENTS/);
  });

  it("requires confirmed ABV before recipe generation", () => {
    expect(() =>
      transition(
        "READY",
        SessionEvent.GENERATE_RECIPE_SET,
        context({ alcoholAbvConfirmed: false }),
      ),
    ).toThrowError(/INVALID_TRANSITION.*READY.*GENERATE_RECIPE_SET/);
  });

  it("requires a recipe set and selected recipe before MIXING", () => {
    expect(() =>
      transition("RECIPE_SELECTION", SessionEvent.SELECT_RECIPE, context({ hasRecipeSet: false })),
    ).toThrowError(/INVALID_TRANSITION.*RECIPE_SELECTION.*SELECT_RECIPE/);

    expect(() =>
      transition(
        "RECIPE_SELECTION",
        SessionEvent.SELECT_RECIPE,
        context({ hasSelectedRecipe: false }),
      ),
    ).toThrowError(/INVALID_TRANSITION.*RECIPE_SELECTION.*SELECT_RECIPE/);
  });

  it("rejects an unrelated event from PREFERENCES", () => {
    expect(() => transition("PREFERENCES", SessionEvent.SELECT_RECIPE, context())).toThrowError(
      /INVALID_TRANSITION.*PREFERENCES.*SELECT_RECIPE/,
    );
  });

  it("does not expose context values in an invalid transition error", () => {
    let thrown: unknown;

    try {
      transition("PREFERENCES", SessionEvent.SELECT_RECIPE, context({ hasPreferences: false }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      return;
    }

    expect(thrown.message).not.toContain("true");
    expect(thrown.message).not.toContain("false");
    expect(thrown.message).not.toContain("secret");
  });
});

describe("MIXING step boundaries", () => {
  it("cannot move backward from the first step", () => {
    expect(() =>
      transition("MIXING", SessionEvent.BACK_MIXING, context({ currentStep: 0, totalSteps: 3 })),
    ).toThrowError(/INVALID_TRANSITION.*MIXING.*BACK_MIXING/);
  });

  it("rejects a missing or out-of-range step window", () => {
    expect(() => transition("MIXING", SessionEvent.ADVANCE_MIXING, context())).toThrowError(
      /INVALID_TRANSITION.*MIXING.*ADVANCE_MIXING/,
    );

    expect(() =>
      transition("MIXING", SessionEvent.ADVANCE_MIXING, context({ currentStep: 3, totalSteps: 3 })),
    ).toThrowError(/INVALID_TRANSITION.*MIXING.*ADVANCE_MIXING/);
  });

  it("enters FEEDBACK only after completing the last step", () => {
    expect(
      transition("MIXING", SessionEvent.ADVANCE_MIXING, context({ currentStep: 1, totalSteps: 2 })),
    ).toBe("FEEDBACK");
  });
});

describe("ADJUSTMENT transitions", () => {
  it("requires the adjusted recipe to be selected before returning to MIXING", () => {
    expect(() =>
      transition(
        "ADJUSTMENT",
        SessionEvent.ACCEPT_ADJUSTMENT,
        context({ hasSelectedRecipe: false }),
      ),
    ).toThrowError(/INVALID_TRANSITION.*ADJUSTMENT.*ACCEPT_ADJUSTMENT/);
  });

  it("can end after feedback without accepting another recipe", () => {
    expect(
      transition(
        "ADJUSTMENT",
        SessionEvent.COMPLETE_SESSION,
        context({ hasSelectedRecipe: false }),
      ),
    ).toBe("COMPLETED");
  });
});
describe("ADJUSTMENT version transitions", () => {
  it("returns to MIXING when a V2 adjusted recipe is selected", () => {
    expect(
      transition(
        "ADJUSTMENT",
        SessionEvent.ACCEPT_ADJUSTMENT,
        context({ hasSelectedRecipe: true, hasSelectedAdjustedRecipe: true }),
      ),
    ).toBe("MIXING");
  });

  it("returns to MIXING when a V3 adjusted recipe is selected after another feedback", () => {
    expect(
      transition(
        "ADJUSTMENT",
        SessionEvent.ACCEPT_ADJUSTMENT,
        context({ hasSelectedRecipe: true, hasSelectedAdjustedRecipe: true }),
      ),
    ).toBe("MIXING");

    expect(
      transition("MIXING", SessionEvent.ADVANCE_MIXING, context({ currentStep: 0, totalSteps: 1 })),
    ).toBe("FEEDBACK");
    expect(transition("FEEDBACK", SessionEvent.SUBMIT_FEEDBACK, context())).toBe("ADJUSTMENT");
    expect(
      transition(
        "ADJUSTMENT",
        SessionEvent.ACCEPT_ADJUSTMENT,
        context({ hasSelectedRecipe: true, hasSelectedAdjustedRecipe: true }),
      ),
    ).toBe("MIXING");
  });

  it("rejects returning to MIXING when no adjusted recipe is selected", () => {
    expect(() =>
      transition(
        "ADJUSTMENT",
        SessionEvent.ACCEPT_ADJUSTMENT,
        context({ hasSelectedRecipe: true, hasSelectedAdjustedRecipe: false }),
      ),
    ).toThrowError(/INVALID_TRANSITION.*ADJUSTMENT.*ACCEPT_ADJUSTMENT/);
  });
});
