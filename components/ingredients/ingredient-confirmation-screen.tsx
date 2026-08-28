"use client";

import { useState } from "react";

import { IngredientRow } from "@/components/ingredients/ingredient-row";
import { FixedActionBar } from "@/components/session/fixed-action-bar";
import type { DetectedIngredient } from "@/src/domain/ingredient";
import { isAlcoholIngredient } from "@/src/providers/vision-provider";
import type {
  ConfirmIngredientsResult,
  SessionClientLike,
} from "@/src/infrastructure/http/session-client";

export interface IngredientConfirmationScreenProps {
  sessionId: string;
  expectedVersion: number;
  initialIngredients: readonly DetectedIngredient[];
  client: SessionClientLike;
  onConfirmed: (result: ConfirmIngredientsResult) => void;
}

const emptyIngredient: DetectedIngredient = {
  rawName: "新材料",
  canonicalName: "新材料",
  category: "unknown",
  brand: null,
  abv: null,
  confidence: 1,
  confirmed: false,
};

export function IngredientConfirmationScreen({
  sessionId,
  expectedVersion,
  initialIngredients,
  client,
  onConfirmed,
}: IngredientConfirmationScreenProps) {
  const [ingredients, setIngredients] = useState<DetectedIngredient[]>([...initialIngredients]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const reasons = [
    ...(ingredients.length === 0 ? ["请至少添加一项材料，再继续。"] : []),
    ...(ingredients.some((ingredient) => !ingredient.confirmed)
      ? ["请先确认所有材料，再继续。"]
      : []),
    ...(ingredients.some((ingredient) => ingredient.category === "unknown")
      ? ["请先把 unknown 材料改成受控类别。"]
      : []),
    ...(ingredients.some((ingredient) => isAlcoholIngredient(ingredient) && ingredient.abv === null)
      ? ["酒类必须先填写并确认 ABV。"]
      : []),
  ];
  const canContinue = reasons.length === 0 && !isSubmitting;

  async function handleConfirm() {
    if (!canContinue) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await client.confirmIngredients({
        sessionId,
        expectedVersion,
        ingredients,
      });
      onConfirmed(result);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "确认失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="space-y-6 pb-32">
      <div className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-amber-700">第三步 · 人工确认</p>
        <h1 className="text-3xl leading-tight font-semibold text-stone-900">确认材料</h1>
        <p className="leading-7 text-stone-600">
          识别模型只负责猜测。请逐项核对、编辑或删除；没有确认的事实不会进入配方生成。
        </p>
      </div>

      {errorMessage !== null ? (
        <div
          className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-800"
          role="alert"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="space-y-4">
        {ingredients.map((ingredient, index) => (
          <IngredientRow
            key={index}
            ingredient={ingredient}
            index={index}
            onChange={(nextIngredient) =>
              setIngredients((current) =>
                current.map((item, itemIndex) => (itemIndex === index ? nextIngredient : item)),
              )
            }
            onDelete={() =>
              setIngredients((current) => current.filter((_item, itemIndex) => itemIndex !== index))
            }
          />
        ))}
      </div>

      <button
        className="min-h-11 w-full rounded-2xl border border-stone-300 bg-white px-5 py-3 font-semibold text-stone-800 hover:bg-stone-50"
        type="button"
        onClick={() => setIngredients((current) => [...current, { ...emptyIngredient }])}
      >
        添加材料
      </button>

      {reasons.length > 0 ? (
        <div
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900"
          role="status"
        >
          <p className="font-semibold">还不能继续：</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <FixedActionBar>
        <button
          className="min-h-11 w-full rounded-2xl bg-stone-900 px-5 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
          type="button"
          disabled={!canContinue}
          onClick={() => void handleConfirm()}
        >
          {isSubmitting ? "正在保存确认…" : "确认材料并继续"}
        </button>
      </FixedActionBar>
    </section>
  );
}
