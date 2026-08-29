"use client";

import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { RecipeCard } from "@/components/recipes/recipe-card";
import { FixedActionBar } from "@/components/session/fixed-action-bar";
import type { RecipeDisplay } from "@/src/domain/recipe";
import {
  SessionClientError,
  type SelectRecipeResult,
  type SessionClientLike,
} from "@/src/infrastructure/http/session-client";

const SWIPE_THRESHOLD_PX = 72;

interface RecipeSelectionScreenProps {
  sessionId: string;
  expectedVersion: number;
  recipeSet: {
    recommendedRecipeId: string;
    recipes: readonly RecipeDisplay[];
  };
  client: SessionClientLike;
  onSelected: (result: SelectRecipeResult) => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
}

export function RecipeSelectionScreen({
  sessionId,
  expectedVersion,
  recipeSet,
  client,
  onSelected,
}: RecipeSelectionScreenProps) {
  const [cursor, setCursor] = useState(0);
  const [warningAcknowledgements, setWarningAcknowledgements] = useState<Set<string>>(
    () => new Set(),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dragDx, setDragDx] = useState(0);
  const [prefersReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const dragState = useRef<DragState | null>(null);

  // 服务端 GET 已通过 deterministic re-ranking 返回完整 recommendation ranking 顺序；
  // 前端直接消费该顺序，只过滤 BLOCK 卡，不得按 recommendedRecipeId 或 A/B/C 重排。
  const deck = useMemo(
    () => recipeSet.recipes.filter((recipe) => recipe.safety.level !== "BLOCK"),
    [recipeSet],
  );
  const blockedRecipes = useMemo(
    () => recipeSet.recipes.filter((recipe) => recipe.safety.level === "BLOCK"),
    [recipeSet.recipes],
  );

  const currentRecipe = deck[cursor];
  const exhausted = currentRecipe === undefined;
  const currentWarnAcknowledged =
    currentRecipe !== undefined &&
    (currentRecipe.safety.level !== "WARN" ||
      warningAcknowledgements.has(currentRecipe.id));
  const canAccept = currentRecipe !== undefined && currentWarnAcknowledged && !isSubmitting;

  function acknowledgeWarning(recipeId: string, checked: boolean) {
    setWarningAcknowledgements((current) => {
      const next = new Set(current);
      if (checked) next.add(recipeId);
      else next.delete(recipeId);
      return next;
    });
  }

  function handleReject() {
    if (isSubmitting || exhausted) return;
    setCursor((current) => Math.min(current + 1, deck.length));
  }

  async function handleAccept() {
    if (currentRecipe === undefined || !currentWarnAcknowledged || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await client.selectRecipe({
        sessionId,
        expectedVersion,
        recipeId: currentRecipe.id,
        warningAcknowledged: currentRecipe.safety.level === "WARN",
      });
      onSelected(result);
    } catch (error) {
      setErrorMessage(error instanceof SessionClientError ? error.message : "选择失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (exhausted || isSubmitting) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, button, label, a")) return;
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragState.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    setDragDx(event.clientX - drag.startX);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragState.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragState.current = null;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setDragDx(0);
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx < 0) {
      handleReject();
      return;
    }
    if (canAccept) void handleAccept();
  }

  function handlePointerCancel() {
    dragState.current = null;
    setDragDx(0);
  }

  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-amber-700">第五步 · 选择方案</p>
        <h1 className="text-3xl leading-tight font-semibold text-stone-900">选择一套配方</h1>
        <p className="leading-7 text-stone-600">
          系统按推荐顺序逐张展示方案。左滑或点“不要这杯”看下一套，右滑或点“选这杯”开始调饮。
        </p>
      </div>

      {errorMessage !== null ? (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          {errorMessage}
        </div>
      ) : null}

      {blockedRecipes.length > 0 ? (
        <aside className="space-y-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900">
          <p className="font-semibold">
            已隐藏 {blockedRecipes.length} 个 BLOCK 方案，仅保留审计摘要。
          </p>
          {blockedRecipes.map((recipe) => (
            <p key={recipe.id}>
              {recipe.title}：{recipe.safety.reasons.join("；")}
            </p>
          ))}
        </aside>
      ) : null}

      {exhausted ? (
        <section
          aria-label="本批方案已看完"
          className="mobile-surface space-y-3 p-6 text-center"
        >
          <p className="text-lg font-semibold text-stone-900">本批方案已全部看完</p>
          <p className="text-sm leading-6 text-stone-600">
            换一批功能即将开放，届时可重新生成三套方案。
          </p>
        </section>
      ) : (
        <>
          <p aria-live="polite" className="text-sm font-medium text-stone-600">
            第 {cursor + 1} / {deck.length} 套
          </p>
          <div
            role="region"
            aria-label="配方卡片滑动区"
            className="overflow-hidden"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          >
            <div
              key={currentRecipe.id}
              className="touch-pan-y"
              style={
                dragDx !== 0 && !prefersReducedMotion
                  ? { transform: `translateX(${dragDx}px)` }
                  : undefined
              }
            >
              <RecipeCard
                recipe={currentRecipe}
                recommended={currentRecipe.id === recipeSet.recommendedRecipeId}
                warningAcknowledged={warningAcknowledgements.has(currentRecipe.id)}
                onWarningChange={(checked) => acknowledgeWarning(currentRecipe.id, checked)}
              />
            </div>
          </div>
        </>
      )}

      <FixedActionBar>
        {exhausted ? (
          <button
            type="button"
            className="min-h-11 w-full rounded-2xl bg-stone-900 px-5 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
            disabled
          >
            换一批
          </button>
        ) : (
          <div className="flex gap-3">
            <button
              type="button"
              className="min-h-11 flex-1 rounded-2xl border border-stone-300 px-4 py-3 text-base font-semibold text-stone-900 disabled:cursor-not-allowed disabled:text-stone-400"
              disabled={isSubmitting}
              onClick={handleReject}
            >
              不要这杯
            </button>
            <button
              type="button"
              className="min-h-11 flex-1 rounded-2xl bg-stone-900 px-4 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
              disabled={!canAccept}
              onClick={() => void handleAccept()}
            >
              {isSubmitting ? "正在进入调饮…" : "选这杯"}
            </button>
          </div>
        )}
      </FixedActionBar>
    </section>
  );
}
