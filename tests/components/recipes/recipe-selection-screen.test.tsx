// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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

const recipeSetSnapshot = {
  data: {
    recipeSet: {
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
    },
  },
  session: { id: sessionId, state: "RECIPE_SELECTION", version: 3 },
};

const recipeSetResponse = {
  recipeSet: recipeSetSnapshot.data.recipeSet,
  session: recipeSetSnapshot.session,
};

describe("recipe selection flow", () => {
  afterEach(() => cleanup());

  it("generates and restores ordered recipe cards without selecting the recommendation", async () => {
    const user = userEvent.setup();
    const client = {
      getSession: vi.fn().mockResolvedValue(readySnapshot),
      generateRecipeSet: vi.fn().mockResolvedValue({
        recipeSet: recipeSetSnapshot.data.recipeSet,
        session: recipeSetSnapshot.session,
      }),
      getRecipeSet: vi.fn().mockResolvedValue(recipeSetResponse),
      selectRecipe: vi.fn(),
      advanceMixing: vi.fn(),
      uploadMixingStepImage: vi.fn(),
      savePreferences: vi.fn(),
      uploadOverviewImage: vi.fn(),
      recognizeIngredients: vi.fn(),
      confirmIngredients: vi.fn(),
    } as SessionClientLike;

    render(<SessionShell sessionId={sessionId} client={client} />);
    expect(await screen.findByRole("heading", { name: "生成三套配方" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "生成三套配方" }));

    expect(await screen.findByRole("heading", { name: "选择一套配方" })).toBeInTheDocument();
    expect(client.generateRecipeSet).toHaveBeenCalledWith({ sessionId, expectedVersion: 2 });
    const cardTitles = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(cardTitles).toEqual(["A 保守方案", "B 创意方案", "C 升级方案"]);
    expect(screen.getByText("推荐方案")).toBeInTheDocument();
    expect(
      screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked),
    ).toBe(true);
    expect(screen.getByText(/先降温再分次加入，突出香气变化。/)).toBeInTheDocument();
    expect(screen.getByText("白酒 · 35 ml")).toBeInTheDocument();
    expect(screen.getByText("预计 ABV：18%")).toBeInTheDocument();
    expect(screen.getByText("先降温，再分次加入白酒。")).toBeInTheDocument();
    expect(screen.getAllByText("安全原因：未命中已知安全规则。")).toHaveLength(2);
    expect(screen.getByText("缺失材料：柠檬")).toBeInTheDocument();
    expect(screen.getByText("安全替代：可改用已确认的果汁。")).toBeInTheDocument();
    expect(screen.getByText(/含有实验性组合，请先少量试饮。/)).toBeInTheDocument();
    expect(client.getRecipeSet).toHaveBeenCalledWith(sessionId);
  });

  it("requires explicit warning confirmation and never renders a BLOCK recipe as selectable", async () => {
    const user = userEvent.setup();
    const blockedSet = {
      ...recipeSetSnapshot,
      data: {
        recipeSet: {
          ...recipeSetSnapshot.data.recipeSet,
          recipes: [
            {
              ...recipeSetSnapshot.data.recipeSet.recipes[0],
              safetyLevel: "BLOCK",
              safety: {
                level: "BLOCK",
                reasons: ["含有不可接受的组合。"],
                alternatives: ["移除该材料后重新生成。"],
              },
            },
            {
              ...recipeSetSnapshot.data.recipeSet.recipes[1],
              safetyLevel: "WARN",
              safety: {
                level: "WARN",
                reasons: ["请先确认该 WARN 提示。"],
                alternatives: ["可改用 A 保守方案。"],
              },
            },
            recipeSetSnapshot.data.recipeSet.recipes[2],
          ],
        },
      },
    };
    const recipeSelectionSnapshot: SessionSnapshot = {
      ...readySnapshot,
      session: { ...readySnapshot.session, state: "RECIPE_SELECTION", version: 3 },
    };
    const client = {
      getSession: vi.fn().mockResolvedValue(recipeSelectionSnapshot),
      getRecipeSet: vi.fn().mockResolvedValue({
        recipeSet: blockedSet.data.recipeSet,
        session: blockedSet.session,
      }),
      selectRecipe: vi.fn(),
      generateRecipeSet: vi.fn(),
      advanceMixing: vi.fn(),
      uploadMixingStepImage: vi.fn(),
      savePreferences: vi.fn(),
      uploadOverviewImage: vi.fn(),
      recognizeIngredients: vi.fn(),
      confirmIngredients: vi.fn(),
    } as SessionClientLike;

    render(<SessionShell sessionId={sessionId} client={client} />);

    expect(await screen.findByRole("heading", { name: "选择一套配方" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "C 升级方案" })).not.toBeInTheDocument();
    expect(screen.getByText("已隐藏 1 个 BLOCK 方案，仅保留审计摘要。")).toBeInTheDocument();
    expect(screen.getByText(/含有不可接受的组合。/)).toBeInTheDocument();

    const warnCard = screen.getByRole("heading", { name: "B 创意方案" }).closest("article");
    expect(warnCard).not.toBeNull();
    const warnRadio = warnCard?.querySelector('input[type="radio"]');
    expect(warnRadio).not.toBeNull();
    expect(warnRadio).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /确认 B 创意方案.*WARN 提示/ }));
    expect(warnRadio).toBeEnabled();
  });

  it("actively selects a recipe with the authoritative version and enters MIXING at step 0", async () => {
    const user = userEvent.setup();
    const selectedRecipe = recipeSetSnapshot.data.recipeSet.recipes[2];
    const client = {
      getSession: vi.fn().mockResolvedValue({
        ...readySnapshot,
        session: { ...readySnapshot.session, state: "RECIPE_SELECTION", version: 3 },
      }),
      getRecipeSet: vi.fn().mockResolvedValue(recipeSetResponse),
      selectRecipe: vi.fn().mockResolvedValue({
        recipeId: selectedRecipe.id,
        currentStep: 0,
        totalSteps: selectedRecipe.steps.length,
        warningAcknowledged: false,
        session: { id: sessionId, state: "MIXING", version: 4 },
      }),
      advanceMixing: vi.fn(),
      uploadMixingStepImage: vi.fn(),
      generateRecipeSet: vi.fn(),
      savePreferences: vi.fn(),
      uploadOverviewImage: vi.fn(),
      recognizeIngredients: vi.fn(),
      confirmIngredients: vi.fn(),
    } as SessionClientLike;

    render(<SessionShell sessionId={sessionId} client={client} />);
    await screen.findByRole("heading", { name: "选择一套配方" });
    await user.click(screen.getByRole("radio", { name: "选择 A 保守方案" }));
    await user.click(screen.getByRole("button", { name: "选择方案并开始调饮" }));

    expect(client.selectRecipe).toHaveBeenCalledWith({
      sessionId,
      expectedVersion: 3,
      recipeId: selectedRecipe.id,
      warningAcknowledged: false,
    });
    expect(
      await screen.findByRole("heading", { name: "第 1 步：加入材料后轻轻搅拌。" }),
    ).toBeInTheDocument();
  });
});
