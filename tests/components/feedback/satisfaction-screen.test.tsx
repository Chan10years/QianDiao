// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionShell } from "@/components/session/session-shell";
import { RecipeCandidateSchema, type RecipeCandidate } from "@/src/domain/recipe";
import {
  SessionClientError,
  type AcceptAdjustmentResult,
  type AdjustmentStateSnapshot,
  type GenerateAdjustmentResult,
  type SaveFeedbackResult,
  type SessionClientLike,
  type SessionSnapshot,
  type VersionedRecipeReadModel,
} from "@/src/infrastructure/http/session-client";
import { makeDomainFixtures } from "@/tests/fixtures/domain";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";
const feedbackId = "323e4567-e89b-12d3-a456-426614174000";

interface SatisfactionFixture {
  snapshot: SessionSnapshot;
  adjustmentState: AdjustmentStateSnapshot;
  currentRecipe: VersionedRecipeReadModel;
  proposal: VersionedRecipeReadModel;
  saveFeedbackResult: SaveFeedbackResult;
  generateResult: GenerateAdjustmentResult;
  acceptResult: AcceptAdjustmentResult;
}

function createFixture(): SatisfactionFixture {
  const fixtures = makeDomainFixtures();
  const candidate = RecipeCandidateSchema.parse({
    ...fixtures.recipes[0],
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
    version: 1,
    parentRecipeId: null,
    feedbackId: null,
    safety: { level: "ALLOW", reasons: ["无已知规则命中。"], alternatives: [] },
    isSelected: true,
  };
  const proposalCandidate: RecipeCandidate = RecipeCandidateSchema.parse({
    ...candidate,
    title: "清爽调整版",
  });
  const proposal: VersionedRecipeReadModel = {
    recipeId: "423e4567-e89b-12d3-a456-426614174000",
    recipeSetId: "523e4567-e89b-12d3-a456-426614174000",
    candidate: proposalCandidate,
    version: 2,
    parentRecipeId: currentRecipe.recipeId,
    feedbackId,
    safety: { level: "ALLOW", reasons: ["无已知规则命中。"], alternatives: [] },
    isSelected: false,
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
      session: { id: sessionId, state: "FEEDBACK", version: 5 },
    },
    adjustmentState: {
      data: { currentRecipe, proposal: null, pendingFeedbackId: null },
      session: { id: sessionId, state: "FEEDBACK", version: 5 },
    },
    currentRecipe,
    proposal,
    saveFeedbackResult: {
      sessionId,
      state: "ADJUSTMENT",
      sessionVersion: 6,
      feedbackId,
      finalImageId: null,
      session: { id: sessionId, state: "ADJUSTMENT", version: 6 },
    },
    generateResult: {
      sessionId,
      state: "ADJUSTMENT",
      sessionVersion: 7,
      currentRecipeId: currentRecipe.recipeId,
      proposedRecipe: proposal,
      safety: proposal.safety,
      session: { id: sessionId, state: "ADJUSTMENT", version: 7 },
    },
    acceptResult: {
      sessionId,
      state: "MIXING",
      sessionVersion: 8,
      currentRecipeId: proposal.recipeId,
      session: { id: sessionId, state: "MIXING", version: 8 },
    },
  };
}

function createClient(
  fixture: SatisfactionFixture,
  overrides: Partial<{
    saveFeedback: SessionClientLike["saveFeedback"];
    generateAdjustment: SessionClientLike["generateAdjustment"];
    acceptAdjustment: SessionClientLike["acceptAdjustment"];
  }> = {},
) {
  return {
    getSession: vi.fn().mockResolvedValue(fixture.snapshot),
    getRecipeSet: vi.fn(),
    getAdjustmentState: vi.fn().mockResolvedValue(fixture.adjustmentState),
    savePreferences: vi.fn(),
    uploadOverviewImage: vi.fn(),
    uploadMixingStepImage: vi.fn(),
    recognizeIngredients: vi.fn(),
    confirmIngredients: vi.fn(),
    generateRecipeSet: vi.fn(),
    selectRecipe: vi.fn(),
    advanceMixing: vi.fn(),
    saveFeedback: vi.fn().mockResolvedValue(fixture.saveFeedbackResult),
    generateAdjustment: vi.fn().mockResolvedValue(fixture.generateResult),
    acceptAdjustment: vi.fn().mockResolvedValue(fixture.acceptResult),
    ...overrides,
  } as SessionClientLike;
}

describe("satisfaction screen", () => {
  afterEach(() => cleanup());

  it("asks satisfaction first without any four-dimension sliders or submit action", async () => {
    const fixture = createFixture();
    const client = createClient(fixture);

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(await screen.findByRole("heading", { name: "满意吗？" })).toBeInTheDocument();
    expect(client.getAdjustmentState).toHaveBeenCalledWith(sessionId);

    // 满意优先：选择前不显示四维滑杆、备注或提交按钮。
    expect(screen.queryByLabelText("甜度调整")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("酸度调整")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("酒感调整")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("浓郁度调整")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交调整反馈" })).not.toBeInTheDocument();

    // 显示当前配方版本与 Safety 摘要。
    expect(screen.getByText(/V1/)).toBeInTheDocument();
    expect(screen.getByText(/安全通过/)).toBeInTheDocument();

    expect(client.saveFeedback).not.toHaveBeenCalled();
  });

  it("satisfied only enters the client satisfied-closing phase without saving feedback or completing", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const client = createClient(fixture);

    render(<SessionShell sessionId={sessionId} client={client} />);

    await user.click(await screen.findByRole("button", { name: "满意" }));

    expect(await screen.findByRole("heading", { name: "满意收尾" })).toBeInTheDocument();
    // 满意 phase 不显示四维滑杆。
    expect(screen.queryByLabelText("甜度调整")).not.toBeInTheDocument();

    // 满意只进入客户端 phase：不保存 accepted=true/任何反馈、不推进完成。
    expect(client.saveFeedback).not.toHaveBeenCalled();
    expect(client.generateAdjustment).not.toHaveBeenCalled();
    expect(client.acceptAdjustment).not.toHaveBeenCalled();
  });

  it("want-adjustment reveals the four dimensions and saves accepted=false feedback before generating Vn+1", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const client = createClient(fixture);

    render(<SessionShell sessionId={sessionId} client={client} />);

    await user.click(await screen.findByRole("button", { name: "还想调整" }));

    fireEvent.change(screen.getByLabelText("甜度调整"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("酒感调整"), { target: { value: "-1" } });
    await user.type(screen.getByLabelText("补充说明（可选）"), "希望更清爽。");

    await user.click(screen.getByRole("button", { name: "提交调整反馈" }));

    await waitFor(() => {
      expect(client.saveFeedback).toHaveBeenCalledWith({
        sessionId,
        expectedVersion: 5,
        recipeId: fixture.currentRecipe.recipeId,
        feedback: {
          rating: 3,
          accepted: false,
          deltas: { sweetness: 1, acidity: 0, alcoholIntensity: -1, body: 0 },
          notes: "希望更清爽。",
        },
      });
    });

    // 保存 accepted=false 后进入 ADJUSTMENT，并基于最新版本生成唯一 Vn+1。
    await waitFor(() => {
      expect(client.generateAdjustment).toHaveBeenCalledWith({
        sessionId,
        expectedVersion: 6,
        feedbackId,
      });
    });
    expect(await screen.findByRole("heading", { name: "清爽调整版" })).toBeInTheDocument();
  });

  it("keeps the adjustment form when saving feedback fails", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const client = createClient(fixture, {
      saveFeedback: vi
        .fn()
        .mockRejectedValue(
          new SessionClientError("VERSION_CONFLICT", "会话版本已过期，请重新加载", true),
        ),
    });

    render(<SessionShell sessionId={sessionId} client={client} />);

    await user.click(await screen.findByRole("button", { name: "还想调整" }));
    await user.click(screen.getByRole("button", { name: "提交调整反馈" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("甜度调整")).toBeInTheDocument();
    expect(client.generateAdjustment).not.toHaveBeenCalled();
  });
});
