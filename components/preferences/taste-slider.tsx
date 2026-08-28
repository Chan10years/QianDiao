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
    <fieldset className="taste-control">
      <legend>{label}</legend>
      <span className="taste-control__value">{value} / 5</span>
      <div className="taste-control__track">
        <input
          id={id}
          aria-label={label}
          className="taste-control__input"
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
      </div>
      <div className="taste-control__scale" aria-hidden="true">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
      <p className="sr-only" aria-live="polite">
        当前：{value}/5
      </p>
    </fieldset>
  );
}
