// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionShell } from "@/components/session/session-shell";
import { RecipeDisplaySchema } from "@/src/domain/recipe";
import type { SessionClientLike, SessionSnapshot } from "@/src/infrastructure/http/session-client";
import { makeDomainFixtures } from "@/tests/fixtures/domain";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";

function createMixingFixture(currentStep: number): {
  snapshot: SessionSnapshot;
  recipeSet: NonNullable<Awaited<ReturnType<SessionClientLike["getRecipeSet"]>>>;
} {
  const fixtures = makeDomainFixtures();
  const recipe = RecipeDisplaySchema.parse({
    ...fixtures.recipes[0],
    steps: [
      { order: 1, instruction: "先加入冰块并降温。", isPhotoCheckpoint: false },
      { order: 2, instruction: "再分次加入白酒并轻轻搅拌。", isPhotoCheckpoint: false },
    ],
    safety: { level: "ALLOW", reasons: ["无已知规则命中。"], alternatives: [] },
  });
  const recipeSet = {
    recipeSet: {
      id: "223e4567-e89b-12d3-a456-426614174000",
      sourceMode: "fallback" as const,
      degraded: true,
      provenance: {
        recipeSetId: "223e4567-e89b-12d3-a456-426614174000",
        sourceMode: "fallback" as const,
        degraded: true,
        stages: [
          {
            phase: "generate" as const,
            attempt: 0,
            sourceMode: "fallback" as const,
            degraded: true,
            outcome: "fallback" as const,
          },
        ],
      },
      recommendedRecipeId: recipe.id,
      recipes: [recipe],
    },
    session: { id: sessionId, state: "MIXING" as const, version: 3 },
  };
  return {
    snapshot: {
      data: {
        preferences: fixtures.tasteProfile,
        selectedRecipeId: recipe.id,
        currentStep,
        ingredients: [],
        mixingPhotos: [],
      },
      session: { id: sessionId, state: "MIXING", version: 3 },
    },
    recipeSet,
  };
}

describe("mixing screen", () => {
  afterEach(() => cleanup());

  it("restores the server step, exposes help/back actions, and prevents duplicate advance clicks", async () => {
    const user = userEvent.setup();
    const fixture = createMixingFixture(0);
    const resolveAdvanceRef: {
      current: ((result: Awaited<ReturnType<SessionClientLike["advanceMixing"]>>) => void) | null;
    } = { current: null };
    const advanceMixing = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<SessionClientLike["advanceMixing"]>>>((resolve) => {
          resolveAdvanceRef.current = resolve;
        }),
    );
    const client = {
      getSession: vi.fn().mockResolvedValue(fixture.snapshot),
      getRecipeSet: vi.fn().mockResolvedValue(fixture.recipeSet),
      savePreferences: vi.fn(),
      uploadOverviewImage: vi.fn(),
      recognizeIngredients: vi.fn(),
      confirmIngredients: vi.fn(),
      generateRecipeSet: vi.fn(),
      selectRecipe: vi.fn(),
      advanceMixing,
      uploadMixingStepImage: vi.fn(),
    } as SessionClientLike;

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(
      await screen.findByRole("heading", { name: "第 1 步：先加入冰块并降温。" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "第 1 步：先加入冰块并降温。" }).closest("section"),
    ).not.toHaveClass("pb-36");
    expect(client.getRecipeSet).toHaveBeenCalledWith(sessionId);
    expect(screen.getByRole("button", { name: "返回上一步" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "遇到问题" }));
    expect(screen.getByText(/如果材料状态与步骤不符/)).toBeInTheDocument();

    const nextButton = screen.getByRole("button", { name: "下一步" });
    await user.click(nextButton);
    await user.click(nextButton);
    expect(advanceMixing).toHaveBeenCalledTimes(1);
    expect(nextButton).toBeDisabled();
    expect(advanceMixing).toHaveBeenCalledWith({
      sessionId,
      expectedVersion: 3,
      action: "ADVANCE_MIXING",
    });

    resolveAdvanceRef.current?.({
      action: "ADVANCE_MIXING",
      currentStep: 1,
      totalSteps: 2,
      session: { id: sessionId, state: "MIXING", version: 4 },
    });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "第 2 步：再分次加入白酒并轻轻搅拌。" }),
      ).toBeInTheDocument();
    });
  });

  it("restores a later currentStep after a fresh session GET", async () => {
    const fixture = createMixingFixture(1);
    const client = {
      getSession: vi.fn().mockResolvedValue(fixture.snapshot),
      getRecipeSet: vi.fn().mockResolvedValue(fixture.recipeSet),
      savePreferences: vi.fn(),
      uploadOverviewImage: vi.fn(),
      recognizeIngredients: vi.fn(),
      confirmIngredients: vi.fn(),
      generateRecipeSet: vi.fn(),
      selectRecipe: vi.fn(),
      advanceMixing: vi.fn(),
      uploadMixingStepImage: vi.fn(),
    } as SessionClientLike;

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(
      await screen.findByRole("heading", { name: "第 2 步：再分次加入白酒并轻轻搅拌。" }),
    ).toBeInTheDocument();
    expect(client.advanceMixing).not.toHaveBeenCalled();
  });
});
