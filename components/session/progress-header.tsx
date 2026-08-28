"use client";

import type { SessionState } from "@/src/domain/session";

const stateLabels: Record<SessionState, string> = {
  PREFERENCES: "口味偏好",
  SCAN: "拍照识别",
  CONFIRM: "确认材料",
  READY: "准备生成",
  RECIPE_SELECTION: "选择配方",
  MIXING: "分步调制",
  FEEDBACK: "成品反馈",
  ADJUSTMENT: "调整配方",
  COMPLETED: "已完成",
};

const stateOrder: readonly SessionState[] = [
  "PREFERENCES",
  "SCAN",
  "CONFIRM",
  "READY",
  "RECIPE_SELECTION",
  "MIXING",
  "FEEDBACK",
  "ADJUSTMENT",
  "COMPLETED",
];

export function ProgressHeader({ state }: { state: SessionState }) {
  const currentIndex = stateOrder.indexOf(state);
  const currentStep = Math.max(currentIndex + 1, 1);

  return (
    <header className="progress-header" aria-label="调饮实验进度">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="mobile-eyebrow">调饮实验</p>
          <p className="mt-1 text-sm font-medium text-stone-600">{stateLabels[state]}</p>
        </div>
        <div className="shrink-0 text-right text-sm text-stone-500">
          <span className="font-semibold text-stone-800">第 {currentStep} 步</span>
          <span className="ml-1">/ 共 {stateOrder.length} 步</span>
        </div>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-stone-200"
        role="progressbar"
        aria-label={`当前进度：${stateLabels[state]}`}
        aria-valuemin={1}
        aria-valuemax={stateOrder.length}
        aria-valuenow={currentStep}
      >
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width]"
          style={{
            width: `${((currentStep / stateOrder.length) * 100).toFixed(2)}%`,
          }}
        />
      </div>
    </header>
  );
}
