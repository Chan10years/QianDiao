"use client";

import type { TasteLevel } from "@/src/domain/preferences";
import { TasteLevelSchema } from "@/src/domain/preferences";

export interface TasteSliderProps {
  id: string;
  label: string;
  value: TasteLevel;
  onChange: (value: TasteLevel) => void;
  minLabel: string;
  maxLabel: string;
}

export function TasteSlider({ id, label, value, onChange, minLabel, maxLabel }: TasteSliderProps) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-base font-medium text-stone-900">{label}</legend>
      <div className="flex items-center gap-3">
        <span className="min-w-12 text-sm text-stone-500">{minLabel}</span>
        <input
          id={id}
          aria-label={label}
          className="h-11 min-w-0 flex-1 accent-amber-700"
          type="range"
          min={1}
          max={5}
          step={1}
          value={value}
          onKeyDown={(event) => {
            const direction =
              event.key === "ArrowRight" || event.key === "ArrowUp"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowDown"
                  ? -1
                  : 0;

            if (direction === 0) return;

            const nextValue = Math.min(5, Math.max(1, value + direction));
            if (nextValue !== value) {
              event.preventDefault();
              onChange(TasteLevelSchema.parse(nextValue));
            }
          }}
          onChange={(event) => {
            const nextValue = TasteLevelSchema.parse(Number(event.target.value));
            onChange(nextValue);
          }}
        />
        <span className="min-w-12 text-right text-sm text-stone-500">{maxLabel}</span>
      </div>
      <p className="text-sm text-stone-600" aria-live="polite">
        当前：{value}/5
      </p>
    </fieldset>
  );
}
