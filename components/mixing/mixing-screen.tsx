"use client";

import { useState } from "react";

import { FixedActionBar } from "@/components/session/fixed-action-bar";
import type { RecipeDisplay } from "@/src/domain/recipe";
import {
  SessionClientError,
  type AdvanceMixingResult,
  type SessionClientLike,
} from "@/src/infrastructure/http/session-client";

interface MixingScreenProps {
  sessionId: string;
  expectedVersion: number;
  currentStep: number | null;
  recipe: RecipeDisplay;
  client: SessionClientLike;
  onAdvanced: (result: AdvanceMixingResult) => void;
}

const STEP_STATE_LABELS = {
  completed: "已完成",
  current: "当前",
  pending: "待完成",
} as const;

type StepState = keyof typeof STEP_STATE_LABELS;

function stepStateClassName(state: StepState): string {
  if (state === "current") {
    return "flex items-start gap-3 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200";
  }
  if (state === "completed") {
    return "flex items-start gap-3 rounded-2xl p-4 opacity-75";
  }
  return "flex items-start gap-3 rounded-2xl p-4 opacity-45";
}

function stepBadgeClassName(state: StepState): string {
  if (state === "current") {
    return "flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-600 text-sm font-bold text-white";
  }
  if (state === "completed") {
    return "flex size-9 shrink-0 items-center justify-center rounded-full bg-stone-800 text-sm font-bold text-white";
  }
  return "flex size-9 shrink-0 items-center justify-center rounded-full bg-stone-200 text-sm font-bold text-stone-500";
}

export function MixingScreen({
  sessionId,
  expectedVersion,
  currentStep,
  recipe,
  client,
  onAdvanced,
}: MixingScreenProps) {
  const step = currentStep === null ? undefined : recipe.steps[currentStep];
  const isLastStep = currentStep !== null && currentStep === recipe.steps.length - 1;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleAction(action: "ADVANCE_MIXING" | "BACK_MIXING") {
    if (isSubmitting || currentStep === null) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await client.advanceMixing({
        sessionId,
        expectedVersion,
        action,
      });
      onAdvanced(result);
    } catch (error) {
      setErrorMessage(error instanceof SessionClientError ? error.message : "步骤更新失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (step === undefined || currentStep === null || currentStep < 0) {
    return (
      <section role="alert" className="mobile-notice mobile-notice--error">
        当前步骤无法恢复，请重新加载服务端会话。
      </section>
    );
  }

  return (
    <section className="space-y-5" aria-label="分步调饮">
      <div className="mobile-surface p-6">
        <div className="mobile-page-header">
          <p className="mobile-eyebrow">
            分步调饮 · 第 {currentStep + 1} / {recipe.steps.length} 步
          </p>
          <h1>
            第 {currentStep + 1} 步：{step.instruction}
          </h1>
          <p>共 {recipe.steps.length} 步 · 进度由服务端记录，刷新后从当前步骤继续</p>
        </div>
      </div>

      {errorMessage !== null ? (
        <div role="alert" className="mobile-notice mobile-notice--error">
          <span className="mobile-notice__label">当前操作没有完成</span>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <ol className="mobile-surface space-y-1 p-3" aria-label="调饮步骤索引">
        {recipe.steps.map((recipeStep, index) => {
          const state: StepState =
            index < currentStep ? "completed" : index === currentStep ? "current" : "pending";
          return (
            <li
              key={recipeStep.order}
              data-step-state={state}
              aria-current={state === "current" ? "step" : undefined}
              className={stepStateClassName(state)}
            >
              <span aria-hidden="true" className={stepBadgeClassName(state)}>
                {state === "completed" ? "✓" : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs tracking-wide text-stone-500">
                  第 {index + 1} 步 · {STEP_STATE_LABELS[state]}
                </p>
                <p
                  className={
                    state === "current"
                      ? "mt-0.5 text-base leading-7 font-semibold text-stone-900"
                      : "mt-0.5 text-sm leading-6 text-stone-700"
                  }
                >
                  {recipeStep.instruction}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mobile-surface space-y-3 p-6">
        <h2 className="text-lg font-bold text-stone-900">本配方用量</h2>
        <ul className="space-y-1 text-sm leading-6 text-stone-700">
          {recipe.materials.map((material) => (
            <li key={`${material.name}-${material.amountMl}`}>
              {material.name} · {material.amountMl} {material.unit}
            </li>
          ))}
        </ul>
        <p className="mobile-notice mobile-notice--warning">
          按步骤逐步加入材料，完成当前操作后再进入下一步。普通步骤不要求拍照。
        </p>
      </div>

      <FixedActionBar>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="mobile-action mobile-action--secondary w-full"
            disabled={isSubmitting || currentStep === 0}
            onClick={() => void handleAction("BACK_MIXING")}
          >
            返回上一步
          </button>
          <button
            type="button"
            className="mobile-action mobile-action--primary w-full"
            disabled={isSubmitting}
            onClick={() => void handleAction("ADVANCE_MIXING")}
          >
            {isSubmitting ? "正在保存…" : isLastStep ? "完成最后一步" : "下一步"}
          </button>
        </div>
      </FixedActionBar>
    </section>
  );
}
