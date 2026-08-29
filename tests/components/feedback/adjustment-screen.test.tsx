// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionShell } from "@/components/session/session-shell";
import { RecipeCandidateSchema, type RecipeCandidate } from "@/src/domain/recipe";
import {
  SessionClientError,
  type AcceptAdjustmentResult,
  type AdjustmentStateSnapshot,
  type GenerateAdjustmentResult,
  type SessionClientLike,
  type SessionSnapshot,
  type VersionedRecipeReadModel,
} from "@/src/infrastructure/http/session-client";
import { makeDomainFixtures } from "@/tests/fixtures/domain";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";
const feedbackId = "323e4567-e89b-12d3-a456-426614174000";

interface AdjustmentFixture {
  snapshot: SessionSnapshot;
  currentRecipe: VersionedRecipeReadModel;
  proposal: VersionedRecipeReadModel;
  generateResult: GenerateAdjustmentResult;
  acceptResult: AcceptAdjustmentResult;
}

function createFixture(): AdjustmentFixture {
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
      session: { id: sessionId, state: "ADJUSTMENT", version: 6 },
    },
    currentRecipe,
    proposal,
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
  fixture: AdjustmentFixture,
  adjustmentState: AdjustmentStateSnapshot["data"],
  overrides: Partial<{
    generateAdjustment: SessionClientLike["generateAdjustment"];
    acceptAdjustment: SessionClientLike["acceptAdjustment"];
  }> = {},
) {
  return {
    getSession: vi.fn().mockResolvedValue(fixture.snapshot),
    getRecipeSet: vi.fn(),
    getAdjustmentState: vi.fn().mockResolvedValue({
      data: adjustmentState,
      session: fixture.snapshot.session,
    }),
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
    generateAdjustment: vi.fn().mockResolvedValue(fixture.generateResult),
    acceptAdjustment: vi.fn().mockResolvedValue(fixture.acceptResult),
    ...overrides,
  } as SessionClientLike;
}

describe("adjustment screen", () => {
  afterEach(() => cleanup());

  it("generates a single Vn+1 proposal, shows version and safety, and accepts back into MIXING at step 1", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const client = createClient(fixture, {
      currentRecipe: fixture.currentRecipe,
      proposal: null,
      pendingFeedbackId: feedbackId,
    });

    render(<SessionShell sessionId={sessionId} client={client} />);

    // 刷新恢复：没有客户端 feedbackId 时使用服务端 pending feedback 生成唯一 proposal。
    await waitFor(() => {
      expect(client.generateAdjustment).toHaveBeenCalledWith({
        sessionId,
        expectedVersion: 6,
        feedbackId,
      });
    });
    expect(client.generateAdjustment).toHaveBeenCalledTimes(1);

    expect(await screen.findByRole("heading", { name: "清爽调整版" })).toBeInTheDocument();
    // proposal 与 current recipe 分开展示：当前仍是 V1，方案是 V2。
    expect(screen.getByText(/基于 V1/)).toBeInTheDocument();
    expect(screen.getByText(/调整方案 · V2/)).toBeInTheDocument();
    expect(screen.getByText(/安全通过/)).toBeInTheDocument();
    expect(screen.getByText(/白酒 · 30 ml/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "按这个继续调" }));

    await waitFor(() => {
      expect(client.acceptAdjustment).toHaveBeenCalledWith({
        sessionId,
        expectedVersion: 7,
        proposedRecipeId: fixture.proposal.recipeId,
      });
    });

    // 接受后 currentStep 重置并回到 MIXING，展示 V2 的第一步。
    expect(
      await screen.findByRole("heading", { name: "第 1 步：先加入冰块并降温。" }),
    ).toBeInTheDocument();
    expect(client.acceptAdjustment).toHaveBeenCalledTimes(1);
  });

  it("recovers an existing proposal after refresh without generating again", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const client = createClient(fixture, {
      currentRecipe: fixture.currentRecipe,
      proposal: fixture.proposal,
      pendingFeedbackId: null,
    });

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(await screen.findByRole("heading", { name: "清爽调整版" })).toBeInTheDocument();
    expect(client.generateAdjustment).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "按这个继续调" }));

    await waitFor(() => {
      expect(client.acceptAdjustment).toHaveBeenCalledWith({
        sessionId,
        expectedVersion: 6,
        proposedRecipeId: fixture.proposal.recipeId,
      });
    });
    expect(
      await screen.findByRole("heading", { name: "第 1 步：先加入冰块并降温。" }),
    ).toBeInTheDocument();
  });

  it("shows an error and allows retrying generation when the provider fails", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const generateAdjustment = vi
      .fn<SessionClientLike["generateAdjustment"]>()
      .mockRejectedValueOnce(
        new SessionClientError("PROVIDER_UNAVAILABLE", "调整服务暂时不可用，请重试", true),
      )
      .mockResolvedValueOnce(fixture.generateResult);
    const client = createClient(
      fixture,
      { currentRecipe: fixture.currentRecipe, proposal: null, pendingFeedbackId: feedbackId },
      { generateAdjustment },
    );

    render(<SessionShell sessionId={sessionId} client={client} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "清爽调整版" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试生成" }));

    expect(await screen.findByRole("heading", { name: "清爽调整版" })).toBeInTheDocument();
    expect(generateAdjustment).toHaveBeenCalledTimes(2);
  });

  it("keeps the proposal when accepting fails with a version conflict", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const client = createClient(
      fixture,
      {
        currentRecipe: fixture.currentRecipe,
        proposal: fixture.proposal,
        pendingFeedbackId: null,
      },
      {
        acceptAdjustment: vi
          .fn()
          .mockRejectedValue(
            new SessionClientError("VERSION_CONFLICT", "会话版本已过期，请重新加载", true),
          ),
      },
    );

    render(<SessionShell sessionId={sessionId} client={client} />);

    await user.click(await screen.findByRole("button", { name: "按这个继续调" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    // 接受失败时 proposal 保留，不偷偷进入 MIXING。
    expect(screen.getByRole("heading", { name: "清爽调整版" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "第 1 步：先加入冰块并降温。" }),
    ).not.toBeInTheDocument();
  });
});
