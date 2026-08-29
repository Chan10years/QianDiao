// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionShell } from "@/components/session/session-shell";
import type { SessionClientLike, SessionSnapshot } from "@/src/infrastructure/http/session-client";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";

const readySnapshot: SessionSnapshot = {
  data: {
    preferences: { sweetness: 3, acidity: 3, alcoholIntensity: 3, body: 3 },
    selectedRecipeId: null,
    currentStep: null,
    ingredients: [],
    mixingPhotos: [],
  },
  session: { id: sessionId, state: "READY", version: 2 },
};

// 服务端返回顺序为 [C, B, A]，推荐第一名是 B：deck 期望顺序为 [B, C, A]。
const recipeSet = {
  id: "223e4567-e89b-12d3-a456-426614174000",
  sourceMode: "fallback",
  degraded: true,
  provenance: {
    recipeSetId: "223e4567-e89b-12d3-a456-426614174000",
    sourceMode: "fallback",
    degraded: true,
    stages: [
      {
        phase: "generate",
        attempt: 0,
        sourceMode: "fallback",
        degraded: true,
        outcome: "fallback",
      },
    ],
  },
  recommendedRecipeId: "323e4567-e89b-12d3-a456-426614174000",
  recipes: [
    {
      id: "323e4567-e89b-12d3-a456-426614174000",
      strategy: "B_CREATIVE",
      title: "B 创意方案",
      fitReason: "适合平衡口味",
      differenceReason: "先降温再分次加入，突出香气变化。",
      materials: [{ name: "白酒", amountMl: 35, unit: "ml" }],
      steps: [{ order: 1, instruction: "先降温，再分次加入白酒。" }],
      estimatedAbv: 18,
      safetyLevel: "ALLOW",
      experimental: false,
      missingIngredients: [],
      safety: {
        level: "ALLOW",
        reasons: ["未命中已知安全规则。"],
        alternatives: [],
      },
    },
    {
      id: "423e4567-e89b-12d3-a456-426614174000",
      strategy: "C_UPGRADE",
      title: "C 升级方案",
      fitReason: "更适合清爽口味",
      differenceReason: "通过补充柠檬和冰块提高层次。",
      materials: [{ name: "白酒", amountMl: 30, unit: "ml" }],
      steps: [{ order: 1, instruction: "加入冰块并搅拌。" }],
      estimatedAbv: 20,
      safetyLevel: "WARN",
      experimental: true,
      missingIngredients: ["柠檬"],
      safety: {
        level: "WARN",
        reasons: ["含有实验性组合，请先少量试饮。"],
        alternatives: ["可改用已确认的果汁。"],
      },
    },
    {
      id: "523e4567-e89b-12d3-a456-426614174000",
      strategy: "A_CONSERVATIVE",
      title: "A 保守方案",
      fitReason: "材料最少，成功率高",
      differenceReason: "只使用已确认材料，降低操作复杂度。",
      materials: [{ name: "白酒", amountMl: 30, unit: "ml" }],
      steps: [{ order: 1, instruction: "加入材料后轻轻搅拌。" }],
      estimatedAbv: 20,
      safetyLevel: "ALLOW",
      experimental: false,
      missingIngredients: [],
      safety: {
        level: "ALLOW",
        reasons: ["未命中已知安全规则。"],
        alternatives: [],
      },
    },
  ],
};

const recipeSelectionSnapshot: SessionSnapshot = {
  data: { ...readySnapshot.data },
  session: { id: sessionId, state: "RECIPE_SELECTION", version: 3 },
};

const recipeSetResponse = {
  recipeSet,
  session: recipeSelectionSnapshot.session,
};

function createClient(overrides: Partial<SessionClientLike> = {}): SessionClientLike {
  return {
    getSession: vi.fn().mockResolvedValue(readySnapshot),
    generateRecipeSet: vi.fn(),
    getRecipeSet: vi.fn(),
    selectRecipe: vi.fn(),
    advanceMixing: vi.fn(),
    uploadMixingStepImage: vi.fn(),
    savePreferences: vi.fn(),
    uploadOverviewImage: vi.fn(),
    recognizeIngredients: vi.fn(),
    confirmIngredients: vi.fn(),
    ...overrides,
  } as SessionClientLike;
}

function swipeElement(element: Element, deltaX: number, deltaY = 0) {
  const startX = 200;
  const startY = 300;
  fireEvent.pointerDown(element, {
    pointerId: 1,
    clientX: startX,
    clientY: startY,
  });
  fireEvent.pointerMove(element, {
    pointerId: 1,
    clientX: startX + Math.round(deltaX / 2),
    clientY: startY + Math.round(deltaY / 2),
  });
  fireEvent.pointerUp(element, {
    pointerId: 1,
    clientX: startX + deltaX,
    clientY: startY + deltaY,
  });
}

describe("recipe selection swipe deck", () => {
  afterEach(() => cleanup());

  it("shows the recommendation-ranked first card and advances locally on reject without client mutations", async () => {
    const user = userEvent.setup();
    const client = createClient({
      generateRecipeSet: vi.fn().mockResolvedValue(recipeSetResponse),
      getRecipeSet: vi.fn().mockResolvedValue(recipeSetResponse),
    });

    render(<SessionShell sessionId={sessionId} client={client} />);
    expect(await screen.findByRole("heading", { name: "生成三套配方" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "生成三套配方" }));

    expect(await screen.findByRole("heading", { name: "选择一套配方" })).toBeInTheDocument();
    expect(client.generateRecipeSet).toHaveBeenCalledWith({ sessionId, expectedVersion: 2 });
    expect(client.generateRecipeSet).toHaveBeenCalledTimes(1);

    // 首屏是 recommendation ranking #1（B），且一次只显示一张。
    expect(screen.getByRole("heading", { name: "B 创意方案" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "A 保守方案" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "C 升级方案" })).not.toBeInTheDocument();
    expect(screen.getByText(/第 1 \/ 3 套/)).toBeInTheDocument();
    expect(screen.getByText("推荐方案")).toBeInTheDocument();
    expect(screen.getByText(/先降温再分次加入，突出香气变化。/)).toBeInTheDocument();

    // 左滑等价操作“不要这杯”只推进本地 deck cursor：B → C → A。
    await user.click(screen.getByRole("button", { name: "不要这杯" }));

    expect(screen.getByRole("heading", { name: "C 升级方案" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "B 创意方案" })).not.toBeInTheDocument();
    expect(screen.getByText(/第 2 \/ 3 套/)).toBeInTheDocument();
    expect(client.selectRecipe).not.toHaveBeenCalled();
    expect(client.generateRecipeSet).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "不要这杯" }));

    expect(screen.getByRole("heading", { name: "A 保守方案" })).toBeInTheDocument();
    expect(screen.getByText(/第 3 \/ 3 套/)).toBeInTheDocument();
    expect(client.selectRecipe).not.toHaveBeenCalled();
  });

  it("ignores small drags and advances to the next card only on a full left swipe", async () => {
    const client = createClient({
      getSession: vi.fn().mockResolvedValue(recipeSelectionSnapshot),
      getRecipeSet: vi.fn().mockResolvedValue(recipeSetResponse),
    });

    render(<SessionShell sessionId={sessionId} client={client} />);
    expect(await screen.findByRole("heading", { name: "选择一套配方" })).toBeInTheDocument();
    const swipeArea = screen.getByRole("region", { name: "配方卡片滑动区" });

    swipeElement(swipeArea, -24);
    expect(screen.getByRole("heading", { name: "B 创意方案" })).toBeInTheDocument();
    expect(screen.getByText(/第 1 \/ 3 套/)).toBeInTheDocument();

    swipeElement(swipeArea, -120);
    expect(screen.getByRole("heading", { name: "C 升级方案" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "B 创意方案" })).not.toBeInTheDocument();
    expect(client.selectRecipe).not.toHaveBeenCalled();
    expect(client.generateRecipeSet).not.toHaveBeenCalled();
  });

  it("accepts the currently displayed recommendation through the click equivalent and calls selectRecipe", async () => {
    const user = userEvent.setup();
    const recommendedRecipe = recipeSet.recipes[0];
    const client = createClient({
      getSession: vi.fn().mockResolvedValue(recipeSelectionSnapshot),
      getRecipeSet: vi.fn().mockResolvedValue(recipeSetResponse),
      selectRecipe: vi.fn().mockResolvedValue({
        recipeId: recommendedRecipe.id,
        currentStep: 0,
        totalSteps: recommendedRecipe.steps.length,
        warningAcknowledged: false,
        session: { id: sessionId, state: "MIXING", version: 4 },
      }),
    });

    render(<SessionShell sessionId={sessionId} client={client} />);
    await screen.findByRole("heading", { name: "选择一套配方" });

    await user.click(screen.getByRole("button", { name: "选这杯" }));

    expect(client.selectRecipe).toHaveBeenCalledTimes(1);
    expect(client.selectRecipe).toHaveBeenCalledWith({
      sessionId,
      expectedVersion: 3,
      recipeId: recommendedRecipe.id,
      warningAcknowledged: false,
    });
    expect(
      await screen.findByRole("heading", { name: "第 1 步：先降温，再分次加入白酒。" }),
    ).toBeInTheDocument();
  });

  it("blocks accepting a WARN card until the warning is explicitly acknowledged", async () => {
    const user = userEvent.setup();
    const warnRecipe = recipeSet.recipes[1];
    const client = createClient({
      getSession: vi.fn().mockResolvedValue(recipeSelectionSnapshot),
      getRecipeSet: vi.fn().mockResolvedValue(recipeSetResponse),
      selectRecipe: vi.fn().mockResolvedValue({
        recipeId: warnRecipe.id,
        currentStep: 0,
        totalSteps: warnRecipe.steps.length,
        warningAcknowledged: true,
        session: { id: sessionId, state: "MIXING", version: 4 },
      }),
    });

    render(<SessionShell sessionId={sessionId} client={client} />);
    await screen.findByRole("heading", { name: "选择一套配方" });

    // 先拒绝推荐 B，让 WARN 卡 C 成为当前卡。
    await user.click(screen.getByRole("button", { name: "不要这杯" }));
    expect(screen.getByRole("heading", { name: "C 升级方案" })).toBeInTheDocument();

    const acceptButton = screen.getByRole("button", { name: "选这杯" });
    expect(acceptButton).toBeDisabled();

    // WARN 未确认时右滑也不得触发选择。
    const swipeArea = screen.getByRole("region", { name: "配方卡片滑动区" });
    swipeElement(swipeArea, 120);
    expect(client.selectRecipe).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: /确认 C 升级方案.*WARN 提示/ }));
    expect(acceptButton).toBeEnabled();

    await user.click(acceptButton);
    expect(client.selectRecipe).toHaveBeenCalledTimes(1);
    expect(client.selectRecipe).toHaveBeenCalledWith({
      sessionId,
      expectedVersion: 3,
      recipeId: warnRecipe.id,
      warningAcknowledged: true,
    });
  });

  it("regenerates only after the user clicks refresh after rejecting all cards", async () => {
    const user = userEvent.setup();
    const regeneratedResponse = {
      recipeSet: { ...recipeSet, id: "623e4567-e89b-12d3-a456-426614174000" },
      session: { id: sessionId, state: "RECIPE_SELECTION" as const, version: 4 },
    };
    const client = createClient({
      getSession: vi.fn().mockResolvedValue(recipeSelectionSnapshot),
      getRecipeSet: vi
        .fn()
        .mockResolvedValueOnce(recipeSetResponse)
        .mockResolvedValueOnce(regeneratedResponse),
      generateRecipeSet: vi.fn().mockResolvedValue({
        recipeSet: regeneratedResponse.recipeSet,
        session: { id: sessionId, state: "RECIPE_SELECTION", version: 4 },
      }),
    });

    render(<SessionShell sessionId={sessionId} client={client} />);
    await screen.findByRole("heading", { name: "选择一套配方" });

    await user.click(screen.getByRole("button", { name: "不要这杯" }));
    await user.click(screen.getByRole("button", { name: "不要这杯" }));
    await user.click(screen.getByRole("button", { name: "不要这杯" }));

    expect(screen.queryByRole("heading", { name: "A 保守方案" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled();
    expect(client.selectRecipe).not.toHaveBeenCalled();
    expect(client.generateRecipeSet).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "换一批" }));
    expect(client.generateRecipeSet).toHaveBeenCalledTimes(1);
    expect(client.generateRecipeSet).toHaveBeenCalledWith({
      sessionId,
      expectedVersion: 3,
    });
    expect(await screen.findByRole("heading", { name: "B 创意方案" })).toBeInTheDocument();
  });

  it("keeps the swipe deck clickable equivalents alongside the gesture", async () => {
    const client = createClient({
      getSession: vi.fn().mockResolvedValue(recipeSelectionSnapshot),
      getRecipeSet: vi.fn().mockResolvedValue(recipeSetResponse),
    });

    render(<SessionShell sessionId={sessionId} client={client} />);
    await screen.findByRole("heading", { name: "选择一套配方" });

    expect(screen.getByRole("button", { name: "不要这杯" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "选这杯" })).toBeInTheDocument();
  });

  it("requires explicit warning confirmation and never renders a BLOCK recipe as a deck card", async () => {
    const user = userEvent.setup();
    const blockedRecipeSet = {
      ...recipeSet,
      recipes: [
        {
          ...recipeSet.recipes[0],
          safetyLevel: "BLOCK",
          safety: {
            level: "BLOCK",
            reasons: ["含有不可接受的组合。"],
            alternatives: ["移除该材料后重新生成。"],
          },
        },
        recipeSet.recipes[1],
        recipeSet.recipes[2],
      ],
    };
    const client = createClient({
      getSession: vi.fn().mockResolvedValue(recipeSelectionSnapshot),
      getRecipeSet: vi.fn().mockResolvedValue({
        recipeSet: blockedRecipeSet,
        session: recipeSelectionSnapshot.session,
      }),
    });

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(await screen.findByRole("heading", { name: "选择一套配方" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "B 创意方案" })).not.toBeInTheDocument();
    expect(screen.getByText("已隐藏 1 个 BLOCK 方案，仅保留审计摘要。")).toBeInTheDocument();
    expect(screen.getByText(/含有不可接受的组合。/)).toBeInTheDocument();

    // BLOCK 卡不入 deck，服务端顺序中剩余 [C, A]，C 是首卡且为 WARN。
    expect(screen.getByRole("heading", { name: "C 升级方案" })).toBeInTheDocument();
    expect(screen.getByText(/第 1 \/ 2 套/)).toBeInTheDocument();

    const acceptButton = screen.getByRole("button", { name: "选这杯" });
    expect(acceptButton).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /确认 C 升级方案.*WARN 提示/ }));
    expect(acceptButton).toBeEnabled();
  });
});
