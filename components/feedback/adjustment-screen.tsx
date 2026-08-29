"use client";

import { useEffect, useRef, useState } from "react";

import { FixedActionBar } from "@/components/session/fixed-action-bar";
import type {
  AcceptAdjustmentResult,
  SessionClientLike,
  VersionedRecipeReadModel,
} from "@/src/infrastructure/http/session-client";
import { SessionClientError } from "@/src/infrastructure/http/session-client";

interface AdjustmentScreenProps {
  sessionId: string;
  expectedVersion: number;
  currentRecipe: VersionedRecipeReadModel;
  proposal: VersionedRecipeReadModel | null;
  pendingFeedbackId: string | null;
  client: SessionClientLike;
  onAccepted: (result: AcceptAdjustmentResult, proposal: VersionedRecipeReadModel) => void;
}

const SAFETY_LEVEL_LABELS: Record<string, string> = {
  ALLOW: "安全通过",
  WARN: "安全警告",
  BLOCK: "安全未通过",
};

function safetyLabel(recipe: VersionedRecipeReadModel): string {
  return SAFETY_LEVEL_LABELS[recipe.safety.level] ?? "安全状态未知";
}

export function AdjustmentScreen({
  sessionId,
  expectedVersion,
  currentRecipe,
  proposal: initialProposal,
  pendingFeedbackId,
  client,
  onAccepted,
}: AdjustmentScreenProps) {
  const [proposal, setProposal] = useState<VersionedRecipeReadModel | null>(initialProposal);
  const [version, setVersion] = useState(expectedVersion);
  const [isGenerating, setIsGenerating] = useState(
    initialProposal === null && pendingFeedbackId !== null,
  );
  const [isAccepting, setIsAccepting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const autoGenerationStarted = useRef(false);

  async function generate() {
    if (pendingFeedbackId === null) return;

    setIsGenerating(true);
    setErrorMessage(null);
    try {
      const result = await client.generateAdjustment({
        sessionId,
        expectedVersion: version,
        feedbackId: pendingFeedbackId,
      });
      setProposal(result.proposedRecipe);
      setVersion(result.sessionVersion);
    } catch (error) {
      setErrorMessage(
        error instanceof SessionClientError ? error.message : "调整方案生成失败，请重试",
      );
    } finally {
      setIsGenerating(false);
    }
  }

  useEffect(() => {
    if (initialProposal !== null || pendingFeedbackId === null) return;
    if (autoGenerationStarted.current) return;
    autoGenerationStarted.current = true;
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAccept() {
    if (proposal === null || isAccepting) return;

    setIsAccepting(true);
    setErrorMessage(null);
    try {
      const result = await client.acceptAdjustment({
        sessionId,
        expectedVersion: version,
        proposedRecipeId: proposal.recipeId,
      });
      onAccepted(result, proposal);
    } catch (error) {
      setErrorMessage(
        error instanceof SessionClientError ? error.message : "调整方案接受失败，请重试",
      );
    } finally {
      setIsAccepting(false);
    }
  }

  if (isGenerating) {
    return (
      <section role="status" aria-live="polite" className="mobile-surface p-6">
        正在生成调整方案…
      </section>
    );
  }

  if (proposal === null) {
    return (
      <section className="space-y-5" aria-label="调整配方">
        <div className="mobile-surface p-6">
          <div className="mobile-page-header">
            <p className="mobile-eyebrow">第七步 · 调整配方</p>
            <h1>生成调整方案</h1>
            <p>系统会基于你的反馈生成一版调整方案。生成失败可以重试。</p>
          </div>
        </div>
        {errorMessage !== null ? (
          <div role="alert" className="mobile-notice mobile-notice--error">
            <span className="mobile-notice__label">当前操作没有完成</span>
            <span>{errorMessage}</span>
          </div>
        ) : null}
        <FixedActionBar>
          <button
            type="button"
            className="mobile-action mobile-action--primary w-full"
            onClick={() => void generate()}
          >
            重试生成
          </button>
        </FixedActionBar>
      </section>
    );
  }

  return (
    <section className="space-y-5" aria-label="调整配方">
      <div className="mobile-surface p-6">
        <div className="mobile-page-header">
          <p className="mobile-eyebrow">第七步 · 调整配方</p>
          <h1>{proposal.candidate.title}</h1>
          <p>基于 V{currentRecipe.version} 的反馈生成，确认后回到分步调饮重新开始。</p>
        </div>
      </div>

      {errorMessage !== null ? (
        <div role="alert" className="mobile-notice mobile-notice--error">
          <span className="mobile-notice__label">当前操作没有完成</span>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <div className="mobile-surface space-y-3 p-6">
        <p className="mobile-eyebrow">
          调整方案 · V{proposal.version} · {safetyLabel(proposal)}
        </p>
        {proposal.safety.reasons.length > 0 ? (
          <p className="text-sm leading-6 text-stone-700">{proposal.safety.reasons[0]}</p>
        ) : null}
        <ul className="space-y-1 text-sm leading-6 text-stone-700">
          {proposal.candidate.materials.map((material) => (
            <li key={`${material.name}-${material.amountMl}`}>
              {material.name} · {material.amountMl} {material.unit}
            </li>
          ))}
        </ul>
      </div>

      <div className="mobile-surface space-y-3 p-6">
        <h2 className="text-lg font-bold text-stone-900">怎么调</h2>
        <ol className="space-y-1 text-sm leading-6 text-stone-700">
          {proposal.candidate.steps.map((step, index) => (
            <li key={step.order}>
              第 {index + 1} 步 · {step.instruction}
            </li>
          ))}
        </ol>
      </div>

      <FixedActionBar>
        <button
          type="button"
          className="mobile-action mobile-action--primary w-full"
          disabled={isAccepting}
          onClick={() => void handleAccept()}
        >
          {isAccepting ? "正在确认…" : "按这个继续调"}
        </button>
      </FixedActionBar>
    </section>
  );
}
