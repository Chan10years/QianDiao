"use client";

import { useState } from "react";

import { ImagePreview } from "@/components/scan/image-preview";
import { FixedActionBar } from "@/components/session/fixed-action-bar";
import type { VersionedRecipeReadModel } from "@/src/infrastructure/http/session-client";
import {
  SessionClientError,
  type SaveFeedbackResult,
  type SessionClientLike,
} from "@/src/infrastructure/http/session-client";

interface FinalDrinkPhotoProps {
  sessionId: string;
  expectedVersion: number;
  currentRecipe: VersionedRecipeReadModel;
  client: SessionClientLike;
  onCompleted: (result: SaveFeedbackResult) => void;
}

const SATISFIED_RATING = 5;

interface UploadedFinalDrink {
  imageId: string;
  expectedVersion: number;
}

/**
 * Task 6：接手 Task 5 的 satisfied-closing phase。
 *
 * final drink 完全可选：拍摄成功后保存 `accepted=true` 与 UUID `finalImageId`，
 * 明确跳过则保存 `finalImageId=null`；两条路径都会经由继承的 saveFeedback 合同
 * 原子完成会话（13A 中 accepted=true 触发 COMPLETE_SESSION），进入 COMPLETED。
 * 上传失败保留重试与跳过两个出口，跳过不阻止完成。
 */
export function FinalDrinkPhoto({
  sessionId,
  expectedVersion,
  currentRecipe,
  client,
  onCompleted,
}: FinalDrinkPhotoProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<UploadedFinalDrink | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function saveSatisfiedFeedback(finalImageId: string | null, version: number) {
    const result = await client.saveFeedback({
      sessionId,
      expectedVersion: version,
      recipeId: currentRecipe.recipeId,
      feedback: {
        rating: SATISFIED_RATING,
        accepted: true,
        deltas: { sweetness: 0, acidity: 0, alcoholIntensity: 0, body: 0 },
        finalImageId,
      },
    });
    onCompleted(result);
  }

  async function handleUploadAndFinish() {
    if (file === null || isFinishing) return;

    setIsFinishing(true);
    setErrorMessage(null);
    try {
      let current = uploaded;
      if (current === null) {
        const upload = await client.uploadFinalDrinkImage({ sessionId, expectedVersion, file });
        current = { imageId: upload.image.id, expectedVersion: upload.session.version };
        setUploaded(current);
      }
      await saveSatisfiedFeedback(current.imageId, current.expectedVersion);
    } catch (error) {
      setErrorMessage(
        error instanceof SessionClientError ? error.message : "收尾操作失败，请重试或跳过",
      );
    } finally {
      setIsFinishing(false);
    }
  }

  async function handleSkip() {
    if (isFinishing) return;

    setIsFinishing(true);
    setErrorMessage(null);
    try {
      await saveSatisfiedFeedback(null, uploaded?.expectedVersion ?? expectedVersion);
    } catch (error) {
      setErrorMessage(error instanceof SessionClientError ? error.message : "完成保存失败，请重试");
    } finally {
      setIsFinishing(false);
    }
  }

  return (
    <section className="mobile-screen space-y-6" aria-label="满意收尾">
      <header className="mobile-page-header">
        <p className="mobile-eyebrow">第六步 · 满意收尾</p>
        <h1>满意收尾</h1>
        <p>可以拍一张这杯成品的照片留档，也可以直接完成。拍摄完全可选，跳过不影响完成。</p>
      </header>

      <div className="mobile-surface space-y-2 p-6">
        <p className="mobile-eyebrow">
          当前配方 · V{currentRecipe.version} · {currentRecipe.candidate.title}
        </p>
        <p className="text-sm leading-6 text-stone-700">
          成品照只作为实验记录，不参与安全判断或自动评分。
        </p>
      </div>

      {errorMessage !== null ? (
        <div role="alert" className="mobile-notice mobile-notice--error">
          <span className="mobile-notice__label">收尾没有完成</span>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <div className="scan-card">
        <div className="scan-frame">
          {file === null ? (
            <label className="scan-frame__empty" htmlFor="final-drink-image">
              <strong>拍摄成品</strong>
              <small>这一杯 · 可选</small>
            </label>
          ) : (
            <>
              <ImagePreview file={file} />
              <label className="scan-frame__replace" htmlFor="final-drink-image">
                替换照片
              </label>
            </>
          )}
        </div>
        <input
          id="final-drink-image"
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          aria-label="选择成品照片"
          onChange={(event) => {
            const nextFile = event.target.files?.[0] ?? null;
            if (nextFile !== null) {
              setFile(nextFile);
              setUploaded(null);
              setErrorMessage(null);
            }
          }}
        />

        <div aria-live="polite" className="scan-status">
          <span className="scan-status__pulse" aria-hidden="true" />
          <span>
            {isFinishing
              ? "正在保存收尾…"
              : file === null
                ? "等待拍摄成品照"
                : "照片已就绪，可以上传完成"}
          </span>
        </div>
      </div>

      <FixedActionBar>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="mobile-action mobile-action--primary w-full"
            disabled={file === null || isFinishing}
            aria-busy={isFinishing}
            onClick={() => void handleUploadAndFinish()}
          >
            {isFinishing ? "正在完成…" : "上传照片并完成"}
          </button>
          <button
            type="button"
            className="mobile-action mobile-action--secondary w-full"
            disabled={isFinishing}
            onClick={() => void handleSkip()}
          >
            跳过，直接完成
          </button>
        </div>
      </FixedActionBar>
    </section>
  );
}
