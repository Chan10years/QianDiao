"use client";

import type { TasteProfile } from "@/src/domain/preferences";
import type { SessionSnapshot } from "@/src/infrastructure/http/session-client";
import { useState } from "react";

import { FixedActionBar } from "@/components/session/fixed-action-bar";
import { TasteSlider } from "@/components/preferences/taste-slider";

export interface PreferencesScreenProps {
  initialPreferences: TasteProfile | null;
  expectedVersion: number;
  onSubmit: (preferences: TasteProfile, expectedVersion: number) => Promise<SessionSnapshot>;
  onSaved?: (snapshot: SessionSnapshot) => void;
}

const DEFAULT_PREFERENCES: TasteProfile = {
  sweetness: 3,
  acidity: 3,
  alcoholIntensity: 3,
  body: 3,
};

const sliderDefinitions = [
  { key: "sweetness", label: "甜度", minLabel: "不甜", maxLabel: "很甜" },
  { key: "acidity", label: "酸度", minLabel: "不酸", maxLabel: "很酸" },
  { key: "alcoholIntensity", label: "酒感", minLabel: "柔和", maxLabel: "强烈" },
  { key: "body", label: "厚重度", minLabel: "清爽", maxLabel: "浓郁" },
] as const satisfies ReadonlyArray<{
  key: keyof TasteProfile;
  label: string;
  minLabel: string;
  maxLabel: string;
}>;

export function PreferencesScreen({
  initialPreferences,
  expectedVersion,
  onSubmit,
  onSaved,
}: PreferencesScreenProps) {
  const [preferences, setPreferences] = useState<TasteProfile>(
    initialPreferences ?? DEFAULT_PREFERENCES,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const snapshot = await onSubmit(preferences, expectedVersion);
      onSaved?.(snapshot);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="mobile-screen space-y-6" onSubmit={handleSubmit}>
      <header className="mobile-page-header">
        <p className="mobile-eyebrow">第一步 · 口味</p>
        <h1>你想喝什么感觉？</h1>
        <p>四个维度各选五档。这里记录的是你的绝对偏好，之后可以根据成品反馈继续调整。</p>
      </header>

      {errorMessage !== null ? (
        <div className="mobile-notice mobile-notice--error" role="alert">
          <span className="mobile-notice__label">保存没有完成</span>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <div className="preferences-card">
        {sliderDefinitions.map((definition) => (
          <TasteSlider
            key={definition.key}
            id={`taste-${definition.key}`}
            label={definition.label}
            value={preferences[definition.key]}
            minLabel={definition.minLabel}
            maxLabel={definition.maxLabel}
            onChange={(value) =>
              setPreferences((current) => ({ ...current, [definition.key]: value }))
            }
          />
        ))}
      </div>

      <FixedActionBar>
        <button
          className="mobile-action mobile-action--primary w-full"
          type="submit"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
        >
          {isSubmitting ? "正在保存…" : "保存口味，开始拍照"}
        </button>
      </FixedActionBar>
    </form>
  );
}
