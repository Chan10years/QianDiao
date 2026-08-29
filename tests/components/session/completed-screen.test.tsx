// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionShell } from "@/components/session/session-shell";
import { RecipeCandidateSchema } from "@/src/domain/recipe";
import {
  type AdjustmentStateSnapshot,
  type SessionClientLike,
  type SessionSnapshot,
  type VersionedRecipeReadModel,
} from "@/src/infrastructure/http/session-client";
import { makeDomainFixtures } from "@/tests/fixtures/domain";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";

interface CompletedFixture {
  snapshot: SessionSnapshot;
  adjustmentState: AdjustmentStateSnapshot;
}

function createFixture(): CompletedFixture {
  const fixtures = makeDomainFixtures();
  const candidate = RecipeCandidateSchema.parse({
    ...fixtures.recipes[0],
    title: "清爽调整版",
    steps: [
      { order: 1, instruction: "先加入冰块并降温。", isPhotoCheckpoint: false },
      { order: 2, instruction: "再分次加入白酒并轻轻搅拌。", isPhotoCheckpoint: false },
      { order: 3, instruction: "最后用柠檬片点缀。", isPhotoCheckpoint: false },
    ],
  });
  const currentRecipe: VersionedRecipeReadModel = {
    recipeId: candidate.id,
    recipeSetId: "223e4567-e89b-12d3-a456-426614174000",
    candidate,
    version: 2,
    parentRecipeId: "823e4567-e89b-12d3-a456-426614174000",
    feedbackId: "323e4567-e89b-12d3-a456-426614174000",
    safety: { level: "ALLOW", reasons: ["无已知规则命中。"], alternatives: [] },
    isSelected: true,
  };

  return {
    snapshot: {
      data: {
        preferences: fixtures.tasteProfile,
        selectedRecipeId: currentRecipe.recipeId,
        currentStep: null,
        ingredients: [],
        mixingPhotos: [],
      },
      session: { id: sessionId, state: "COMPLETED", version: 9 },
    },
    adjustmentState: {
      data: { currentRecipe, proposal: null, pendingFeedbackId: null },
      session: { id: sessionId, state: "COMPLETED", version: 9 },
    },
  };
}

function createClient(fixture: CompletedFixture) {
  return {
    getSession: vi.fn().mockResolvedValue(fixture.snapshot),
    getRecipeSet: vi.fn(),
    getAdjustmentState: vi.fn().mockResolvedValue(fixture.adjustmentState),
    savePreferences: vi.fn(),
    uploadOverviewImage: vi.fn(),
    uploadFinalDrinkImage: vi.fn(),
    uploadMixingStepImage: vi.fn(),
    recognizeIngredients: vi.fn(),
    confirmIngredients: vi.fn(),
    generateRecipeSet: vi.fn(),
    selectRecipe: vi.fn(),
    advanceMixing: vi.fn(),
    saveFeedback: vi.fn(),
    generateAdjustment: vi.fn(),
    acceptAdjustment: vi.fn(),
  } as SessionClientLike;
}

describe("completed screen", () => {
  afterEach(() => cleanup());

  it("restores a completed session with the final recipe and no mutating actions", async () => {
    const fixture = createFixture();
    const client = createClient(fixture);

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(await screen.findByRole("heading", { name: "调饮完成" })).toBeInTheDocument();

    // 完成状态恢复：加载当前配方用于展示，不触发任何写操作。
    await waitFor(() => {
      expect(client.getAdjustmentState).toHaveBeenCalledWith(sessionId);
    });
    expect(await screen.findByText(/清爽调整版/)).toBeInTheDocument();
    expect(screen.getByText(/V2/)).toBeInTheDocument();
    expect(screen.getByText(/安全通过/)).toBeInTheDocument();

    expect(client.saveFeedback).not.toHaveBeenCalled();
    expect(client.generateAdjustment).not.toHaveBeenCalled();
    expect(client.acceptAdjustment).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "满意" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "跳过，直接完成" })).not.toBeInTheDocument();
  });
});
