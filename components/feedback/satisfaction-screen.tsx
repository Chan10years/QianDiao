"use client";

import { useState } from "react";

import { FixedActionBar } from "@/components/session/fixed-action-bar";
import type { FeedbackDelta, FeedbackDeltas } from "@/src/domain/feedback";
import type { VersionedRecipeReadModel } from "@/src/infrastructure/http/session-client";
import {
  SessionClientError,
  type SaveFeedbackResult,
  type SessionClientLike,
} from "@/src/infrastructure/http/session-client";

interface SatisfactionScreenProps {
  sessionId: string;
  expectedVersion: number;
  currentRecipe: VersionedRecipeReadModel;
  client: SessionClientLike;
  onSatisfied: () => void;
  onFeedbackSaved: (result: SaveFeedbackResult) => void;
}

const DIMENSIONS: {
  key: keyof FeedbackDeltas;
  label: string;
  minLabel: string;
  maxLabel: string;
}[] = [
  { key: "sweetness", label: "甜度调整", minLabel: "更清爽", maxLabel: "更甜" },
  { key: "acidity", label: "酸度调整", minLabel: "更柔和", maxLabel: "更酸" },
  { key: "alcoholIntensity", label: "酒感调整", minLabel: "更轻", maxLabel: "更烈" },
  { key: "body", label: "浓郁度调整", minLabel: "更薄", maxLabel: "更厚" },
];

const SAFETY_LEVEL_LABELS: Record<string, string> = {
  ALLOW: "安全通过",
  WARN: "安全警告",
  BLOCK: "安全未通过",
};

function safetyLabel(recipe: VersionedRecipeReadModel): string {
  return SAFETY_LEVEL_LABELS[recipe.safety.level] ?? "安全状态未知";
}

const ADJUSTMENT_RATING = 3;

export function SatisfactionScreen({
  sessionId,
  expectedVersion,
  currentRecipe,
  client,
  onSatisfied,
  onFeedbackSaved,
}: SatisfactionScreenProps) {
  const [phase, setPhase] = useState<"satisfaction" | "adjustment-form">("satisfaction");
  const [deltas, setDeltas] = useState<FeedbackDeltas>({
    sweetness: 0,
    acidity: 0,
    alcoholIntensity: 0,
    body: 0,
  });
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleDeltaChange(key: keyof FeedbackDeltas, value: FeedbackDelta) {
    setDeltas((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmitAdjustment() {
    if (isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    const trimmedNotes = notes.trim();
    try {
      const result = await client.saveFeedback({
        sessionId,
        expectedVersion,
        recipeId: currentRecipe.recipeId,
        feedback: {
          rating: ADJUSTMENT_RATING,
          accepted: false,
          deltas,
          ...(trimmedNotes.length > 0 ? { notes: trimmedNotes } : {}),
        },
      });
      onFeedbackSaved(result);
    } catch (error) {
      setErrorMessage(error instanceof SessionClientError ? error.message : "反馈保存失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="space-y-5" aria-label="成品反馈">
      <div className="mobile-surface p-6">
        <div className="mobile-page-header">
          <p className="mobile-eyebrow">第六步 · 成品反馈</p>
          <h1>{phase === "satisfaction" ? "满意吗？" : "想怎么调整？"}</h1>
          <p>
            {phase === "satisfaction"
              ? "先告诉我们这杯的整体感受，满意就收尾，不满意才需要填写调整。"
              : "用相对方向描述这杯哪里不对，系统会生成一版调整方案。"}
          </p>
        </div>
      </div>

      <div className="mobile-surface space-y-2 p-6">
        <p className="mobile-eyebrow">
          当前配方 · V{currentRecipe.version} · {currentRecipe.candidate.title}
        </p>
        <p className="text-sm leading-6 text-stone-700">
          {safetyLabel(currentRecipe)}
          {currentRecipe.safety.reasons.length > 0 ? ` · ${currentRecipe.safety.reasons[0]}` : ""}
        </p>
        <ul className="space-y-1 text-sm leading-6 text-stone-700">
          {currentRecipe.candidate.materials.map((material) => (
            <li key={`${material.name}-${material.amountMl}`}>
              {material.name} · {material.amountMl} {material.unit}
            </li>
          ))}
        </ul>
      </div>

      {errorMessage !== null ? (
        <div role="alert" className="mobile-notice mobile-notice--error">
          <span className="mobile-notice__label">当前操作没有完成</span>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {phase === "satisfaction" ? (
        <FixedActionBar>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className="mobile-action mobile-action--primary w-full"
              onClick={onSatisfied}
            >
              满意
            </button>
            <button
              type="button"
              className="mobile-action mobile-action--secondary w-full"
              onClick={() => setPhase("adjustment-form")}
            >
              还想调整
            </button>
          </div>
        </FixedActionBar>
      ) : (
        <div className="mobile-surface space-y-5 p-6">
          {DIMENSIONS.map((dimension) => (
            <fieldset key={dimension.key} className="taste-control">
              <legend>{dimension.label}</legend>
              <span className="taste-control__value">
                {deltas[dimension.key] > 0 ? `+${deltas[dimension.key]}` : deltas[dimension.key]} /
                ±2
              </span>
              <div className="taste-control__track">
                <input
                  aria-label={dimension.label}
                  className="taste-control__input"
                  type="range"
                  min={-2}
                  max={2}
                  step={1}
                  value={deltas[dimension.key]}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value);
                    if (nextValue >= -2 && nextValue <= 2 && Number.isInteger(nextValue)) {
                      handleDeltaChange(dimension.key, nextValue as FeedbackDelta);
                    }
                  }}
                />
              </div>
              <div className="taste-control__scale" aria-hidden="true">
                <span>{dimension.minLabel}</span>
                <span>{dimension.maxLabel}</span>
              </div>
            </fieldset>
          ))}

          <div className="space-y-2">
            <label htmlFor="adjustment-notes" className="text-sm font-semibold text-stone-900">
              补充说明（可选）
            </label>
            <textarea
              id="adjustment-notes"
              className="w-full rounded-2xl border border-stone-300 bg-white p-3 text-sm leading-6 text-stone-900"
              rows={3}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="例如：希望更清爽。"
            />
          </div>
        </div>
      )}

      {phase === "adjustment-form" ? (
        <FixedActionBar>
          <button
            type="button"
            className="mobile-action mobile-action--primary w-full"
            disabled={isSubmitting}
            onClick={() => void handleSubmitAdjustment()}
          >
            {isSubmitting ? "正在保存反馈…" : "提交调整反馈"}
          </button>
        </FixedActionBar>
      ) : null}
    </section>
  );
}
