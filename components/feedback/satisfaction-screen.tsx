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
    <section className={`satisfaction-screen satisfaction-screen--${phase}`} aria-label="成品反馈">
      <div className="satisfaction-screen__intro">
        {phase === "satisfaction" ? (
          <div className="seal" aria-hidden="true">
            黔味
          </div>
        ) : null}
        <div className="mobile-page-header">
          <p className="mobile-eyebrow">第六步 · 成品反馈</p>
          <h1>{phase === "satisfaction" ? "这一杯，满意吗？" : "下一版，往哪调？"}</h1>
          <p>
            {phase === "satisfaction"
              ? "满意就收下这一杯；还想调整，再告诉我一点方向。"
              : "用相对方向描述感受，下一版会基于这次反馈重新调配。"}
          </p>
        </div>
      </div>

      <div className="satisfaction-screen__recipe">
        <p className="mobile-eyebrow">
          当前配方 · V{currentRecipe.version} · {currentRecipe.candidate.title}
        </p>
        <p className="text-sm leading-6 text-stone-700">
          {safetyLabel(currentRecipe)}
          {currentRecipe.safety.reasons.length > 0 ? ` · ${currentRecipe.safety.reasons[0]}` : ""}
        </p>
        <ul>
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
        <div className="satisfaction-screen__adjustment-form">
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
            <label htmlFor="adjustment-notes" className="satisfaction-screen__notes-label">
              补充说明（可选）
            </label>
            <textarea
              id="adjustment-notes"
              className="satisfaction-screen__notes"
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
