// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionShell } from "@/components/session/session-shell";
import { RecipeDisplaySchema } from "@/src/domain/recipe";
import {
  SessionClientError,
  type SessionClientLike,
  type SessionSnapshot,
} from "@/src/infrastructure/http/session-client";
import { makeDomainFixtures } from "@/tests/fixtures/domain";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";

interface MixingFixture {
  snapshot: SessionSnapshot;
  recipeSet: NonNullable<Awaited<ReturnType<SessionClientLike["getRecipeSet"]>>>;
}

// 第 2 步带 isPhotoCheckpoint: true，用于锁定新版 Mixing 不渲染任何 checkpoint photo UI。
function createMixingFixture(currentStep: number): MixingFixture {
  const fixtures = makeDomainFixtures();
  const recipe = RecipeDisplaySchema.parse({
    ...fixtures.recipes[0],
    steps: [
      { order: 1, instruction: "先加入冰块并降温。", isPhotoCheckpoint: false },
      { order: 2, instruction: "再分次加入白酒并轻轻搅拌。", isPhotoCheckpoint: true },
      { order: 3, instruction: "最后用柠檬片点缀。", isPhotoCheckpoint: false },
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

function createClient(fixture: MixingFixture, advanceMixing: SessionClientLike["advanceMixing"]) {
  return {
    getSession: vi.fn().mockResolvedValue(fixture.snapshot),
    getRecipeSet: vi.fn().mockResolvedValue(fixture.recipeSet),
    savePreferences: vi.fn(),
    uploadOverviewImage: vi.fn(),
    uploadFinalDrinkImage: vi.fn(),
    recognizeIngredients: vi.fn(),
    confirmIngredients: vi.fn(),
    generateRecipeSet: vi.fn(),
    selectRecipe: vi.fn(),
    advanceMixing,
    uploadMixingStepImage: vi.fn(),
    getAdjustmentState: vi.fn(),
    saveFeedback: vi.fn(),
    generateAdjustment: vi.fn(),
    acceptAdjustment: vi.fn(),
  } as SessionClientLike;
}

describe("mixing screen", () => {
  afterEach(() => cleanup());

  it("renders the vertical stepper with completed/current/pending states and no checkpoint photo UI", async () => {
    const fixture = createMixingFixture(1);
    const client = createClient(fixture, vi.fn());

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(
      await screen.findByRole("heading", { name: "第 2 步：再分次加入白酒并轻轻搅拌。" }),
    ).toBeInTheDocument();
    expect(client.getRecipeSet).toHaveBeenCalledWith(sessionId);
    expect(screen.getByRole("main", { name: "调饮实验" })).toHaveAttribute(
      "data-shell-bottom-spacing",
      "action-bar",
    );
    expect(screen.getByRole("region", { name: "当前操作" })).toBeInTheDocument();

    const steps = within(screen.getByRole("list", { name: "调饮步骤索引" })).getAllByRole(
      "listitem",
    );
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveAttribute("data-step-state", "completed");
    expect(steps[1]).toHaveAttribute("data-step-state", "current");
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(steps[2]).toHaveAttribute("data-step-state", "pending");

    expect(screen.getByText("白酒 · 30 ml")).toBeInTheDocument();
    expect(screen.getByText(/共 3 步/)).toBeInTheDocument();

    // 步骤 2 是 photo checkpoint，但新版 UI 不渲染任何拍照入口。
    expect(screen.queryByRole("heading", { name: "拍照专页" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拍摄关键步骤" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂时跳过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "替换照片" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("拍摄关键步骤照片")).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "返回上一步" })).toBeEnabled();
  });

  it("advances from the first step, blocks duplicate clicks, and supports going back", async () => {
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
    const client = createClient(fixture, advanceMixing);

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(
      await screen.findByRole("heading", { name: "第 1 步：先加入冰块并降温。" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回上一步" })).toBeDisabled();

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
      totalSteps: 3,
      session: { id: sessionId, state: "MIXING", version: 4 },
    });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "第 2 步：再分次加入白酒并轻轻搅拌。" }),
      ).toBeInTheDocument();
    });
    const steps = within(screen.getByRole("list", { name: "调饮步骤索引" })).getAllByRole(
      "listitem",
    );
    expect(steps[0]).toHaveAttribute("data-step-state", "completed");
    expect(steps[1]).toHaveAttribute("data-step-state", "current");

    await user.click(screen.getByRole("button", { name: "返回上一步" }));
    expect(advanceMixing).toHaveBeenLastCalledWith({
      sessionId,
      expectedVersion: 4,
      action: "BACK_MIXING",
    });
  });

  it("restores a later currentStep after a fresh session GET without any mutation", async () => {
    const fixture = createMixingFixture(2);
    const client = createClient(fixture, vi.fn());

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(
      await screen.findByRole("heading", { name: "第 3 步：最后用柠檬片点缀。" }),
    ).toBeInTheDocument();
    expect(client.advanceMixing).not.toHaveBeenCalled();
    const steps = within(screen.getByRole("list", { name: "调饮步骤索引" })).getAllByRole(
      "listitem",
    );
    expect(steps[0]).toHaveAttribute("data-step-state", "completed");
    expect(steps[1]).toHaveAttribute("data-step-state", "completed");
    expect(steps[2]).toHaveAttribute("data-step-state", "current");
  });

  it("advances the final step into FEEDBACK", async () => {
    const user = userEvent.setup();
    const fixture = createMixingFixture(2);
    const resolveAdvanceRef: {
      current: ((result: Awaited<ReturnType<SessionClientLike["advanceMixing"]>>) => void) | null;
    } = { current: null };
    const advanceMixing = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<SessionClientLike["advanceMixing"]>>>((resolve) => {
          resolveAdvanceRef.current = resolve;
        }),
    );
    const client = createClient(fixture, advanceMixing);

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(
      await screen.findByRole("heading", { name: "第 3 步：最后用柠檬片点缀。" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "完成最后一步" }));
    expect(advanceMixing).toHaveBeenCalledWith({
      sessionId,
      expectedVersion: 3,
      action: "ADVANCE_MIXING",
    });

    resolveAdvanceRef.current?.({
      action: "ADVANCE_MIXING",
      currentStep: null,
      totalSteps: 3,
      session: { id: sessionId, state: "FEEDBACK", version: 4 },
    });
    await waitFor(() => {
      // Task 5：最后一步进入 FEEDBACK 后由满意优先反馈接手（恢复 adjustmentState）。
      expect(screen.getByText("正在恢复反馈状态…")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "完成最后一步" })).not.toBeInTheDocument();
  });

  it("keeps the current step without hidden progression when advancing fails", async () => {
    const user = userEvent.setup();
    const fixture = createMixingFixture(0);
    const advanceMixing = vi
      .fn<SessionClientLike["advanceMixing"]>()
      .mockRejectedValue(
        new SessionClientError("VERSION_CONFLICT", "会话已被其他操作更新，请重试", false),
      );
    const client = createClient(fixture, advanceMixing);

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(
      await screen.findByRole("heading", { name: "第 1 步：先加入冰块并降温。" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一步" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(advanceMixing).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "第 1 步：先加入冰块并降温。" }),
    ).toBeInTheDocument();
    // 409 后 shell 重新拉取服务端快照，仍停留在服务端记录的第 1 步。
    expect(client.getSession).toHaveBeenCalledTimes(2);
  });
});
