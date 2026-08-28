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
      <div className="app-top">
        <div>
          <p className="app-brand">黔味一口</p>
          <p className="mobile-eyebrow">调饮实验</p>
        </div>
        <p className="app-code">AI MIX / FIELD TEST</p>
      </div>
      <div className="progress-header__meta">
        <p className="progress-header__state">{stateLabels[state]}</p>
        <p className="progress-header__count">
          <span>第 {currentStep} 步</span>
          <span>/ 共 {stateOrder.length} 步</span>
        </p>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={`当前进度：${stateLabels[state]}`}
        aria-valuemin={1}
        aria-valuemax={stateOrder.length}
        aria-valuenow={currentStep}
      >
        <div
          className="progress-track__fill"
          style={{
            width: `${((currentStep / stateOrder.length) * 100).toFixed(2)}%`,
          }}
        />
      </div>
    </header>
  );
}
