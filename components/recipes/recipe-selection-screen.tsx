"use client";

import { useMemo, useState } from "react";

import { RecipeCard } from "@/components/recipes/recipe-card";
import { FixedActionBar } from "@/components/session/fixed-action-bar";
import type { RecipeDisplay } from "@/src/domain/recipe";
import {
  SessionClientError,
  type SelectRecipeResult,
  type SessionClientLike,
} from "@/src/infrastructure/http/session-client";

const strategyOrder: Record<RecipeDisplay["strategy"], number> = {
  A_CONSERVATIVE: 0,
  B_CREATIVE: 1,
  C_UPGRADE: 2,
};

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

export function RecipeSelectionScreen({
  sessionId,
  expectedVersion,
  recipeSet,
  client,
  onSelected,
}: RecipeSelectionScreenProps) {
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [warningAcknowledgements, setWarningAcknowledgements] = useState<Set<string>>(
    () => new Set(),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectableRecipes = useMemo(
    () =>
      recipeSet.recipes
        .filter((recipe) => recipe.safety.level !== "BLOCK")
        .sort((left, right) => strategyOrder[left.strategy] - strategyOrder[right.strategy]),
    [recipeSet.recipes],
  );
  const blockedRecipes = useMemo(
    () => recipeSet.recipes.filter((recipe) => recipe.safety.level === "BLOCK"),
    [recipeSet.recipes],
  );
  const selectedRecipe = selectableRecipes.find((recipe) => recipe.id === selectedRecipeId);
  const selectedWarnAcknowledged =
    selectedRecipe?.safety.level !== "WARN" || warningAcknowledgements.has(selectedRecipe.id);

  async function handleSelect() {
    if (selectedRecipe === undefined || !selectedWarnAcknowledged || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await client.selectRecipe({
        sessionId,
        expectedVersion,
        recipeId: selectedRecipe.id,
        warningAcknowledged: selectedRecipe.safety.level === "WARN",
      });
      onSelected(result);
    } catch (error) {
      setErrorMessage(error instanceof SessionClientError ? error.message : "选择失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="space-y-6 pb-32">
      <div className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-amber-700">第五步 · 选择方案</p>
        <h1 className="text-3xl leading-tight font-semibold text-stone-900">选择一套配方</h1>
        <p className="leading-7 text-stone-600">
          三套方案按 A / B / C 排列。推荐只代表系统建议，你需要主动选择后才能开始调饮。
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

      <div role="radiogroup" aria-label="配方选择" className="space-y-5">
        {selectableRecipes.map((recipe) => (
          <RecipeCard
            key={recipe.id}
            recipe={recipe}
            recommended={recipe.id === recipeSet.recommendedRecipeId}
            selected={recipe.id === selectedRecipeId}
            warningAcknowledged={warningAcknowledgements.has(recipe.id)}
            onSelect={() => setSelectedRecipeId(recipe.id)}
            onWarningChange={(checked) => {
              setWarningAcknowledgements((current) => {
                const next = new Set(current);
                if (checked) next.add(recipe.id);
                else next.delete(recipe.id);
                return next;
              });
            }}
          />
        ))}
      </div>

      <FixedActionBar>
        <button
          type="button"
          className="min-h-11 w-full rounded-2xl bg-stone-900 px-5 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
          disabled={selectedRecipe === undefined || !selectedWarnAcknowledged || isSubmitting}
          onClick={() => void handleSelect()}
        >
          {isSubmitting ? "正在进入调饮…" : "选择方案并开始调饮"}
        </button>
      </FixedActionBar>
    </section>
  );
}
