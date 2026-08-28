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

  return (
    <header className="space-y-3">
      <div className="flex items-center justify-between text-sm text-stone-500">
        <span>调饮实验</span>
        <span>
          {Math.max(currentIndex + 1, 1)} / {stateOrder.length}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-stone-200"
        role="progressbar"
        aria-label={`当前进度：${stateLabels[state]}`}
        aria-valuemin={1}
        aria-valuemax={stateOrder.length}
        aria-valuenow={Math.max(currentIndex + 1, 1)}
      >
        <div
          className="h-full rounded-full bg-amber-600 transition-[width]"
          style={{
            width: `${((Math.max(currentIndex + 1, 1) / stateOrder.length) * 100).toFixed(2)}%`,
          }}
        />
      </div>
      <p className="text-sm font-medium text-amber-700">{stateLabels[state]}</p>
    </header>
  );
}
