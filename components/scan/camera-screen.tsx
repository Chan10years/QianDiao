"use client";

import { useEffect, useRef, useState } from "react";

import { ImagePreview } from "@/components/scan/image-preview";
import { FixedActionBar } from "@/components/session/fixed-action-bar";
import type { DetectedIngredient } from "@/src/domain/ingredient";
import type { SessionClientLike, SessionEnvelope } from "@/src/infrastructure/http/session-client";

export interface CameraScreenProps {
  sessionId: string;
  expectedVersion: number;
  client: SessionClientLike;
  onRecognized: (result: {
    ingredients: readonly DetectedIngredient[];
    overviewImageId: string;
    session: SessionEnvelope;
  }) => void;
}

type CameraStage = "idle" | "uploading" | "recognizing";

interface UploadedOverview {
  imageId: string;
  expectedVersion: number;
}

export function CameraScreen({
  sessionId,
  expectedVersion,
  client,
  onRecognized,
}: CameraScreenProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploadedOverview, setUploadedOverview] = useState<UploadedOverview | null>(null);
  const [stage, setStage] = useState<CameraStage>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const previousExpectedVersion = useRef(expectedVersion);

  useEffect(() => {
    const versionChanged = previousExpectedVersion.current !== expectedVersion;
    previousExpectedVersion.current = expectedVersion;
    if (!versionChanged) return;

    let active = true;
    queueMicrotask(() => {
      if (active) setUploadedOverview(null);
    });
    return () => {
      active = false;
    };
  }, [expectedVersion]);

  async function handleSubmit() {
    if (file === null || stage !== "idle") return;

    setStage("uploading");
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      let overview = uploadedOverview;
      if (overview === null) {
        const upload = await client.uploadOverviewImage({ sessionId, expectedVersion, file });
        overview = {
          imageId: upload.image.id,
          expectedVersion: upload.session.version,
        };
        setUploadedOverview(overview);
      }
      setStage("recognizing");
      const recognition = await client.recognizeIngredients({
        sessionId,
        expectedVersion: overview.expectedVersion,
        overviewImageId: overview.imageId,
        labelImageIds: [],
      });
      setStage("idle");
      setSuccessMessage("识别完成，等待确认");
      onRecognized({
        ingredients: recognition.recognition.ingredients,
        overviewImageId: overview.imageId,
        session: recognition.session,
      });
    } catch (error) {
      setStage("idle");
      setErrorMessage(error instanceof Error ? error.message : "上传失败，请重试");
    }
  }

  return (
    <section className="mobile-screen space-y-6">
      <header className="mobile-page-header">
        <p className="mobile-eyebrow">第二步 · 识别</p>
        <h1>拍照桌面材料</h1>
        <p>
          把酒和想加入的材料放在同一张桌面总览图里。识别结果只作为草稿，下一步可以逐项修改和确认。
        </p>
      </header>

      {errorMessage !== null ? (
        <div className="mobile-notice mobile-notice--error" role="alert">
          <span className="mobile-notice__label">识别没有完成</span>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {successMessage !== null ? (
        <p className="mobile-notice mobile-notice--success" role="status">
          <span className="mobile-notice__label">识别完成</span>
          <span>{successMessage}</span>
        </p>
      ) : null}

      <div className="scan-card">
        <div className="scan-frame">
          {file === null ? (
            <label className="scan-frame__empty" htmlFor="overview-image">
              <strong>拍摄桌面</strong>
              <small>酒 · 饮料 · 水果 · 冰块</small>
            </label>
          ) : (
            <>
              <ImagePreview file={file} />
              <label className="scan-frame__replace" htmlFor="overview-image">
                替换照片
              </label>
            </>
          )}
        </div>
        <input
          id="overview-image"
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          aria-label="选择桌面照片"
          onChange={(event) => {
            const nextFile = event.target.files?.[0] ?? null;
            if (nextFile !== null) {
              setFile(nextFile);
              setUploadedOverview(null);
              setErrorMessage(null);
              setSuccessMessage(null);
            }
          }}
        />

        <div aria-live="polite" className="scan-status">
          <span className="scan-status__pulse" aria-hidden="true" />
          <span>
            {stage === "uploading"
              ? "正在上传照片…"
              : stage === "recognizing"
                ? "正在识别材料…"
                : file === null
                  ? "等待拍摄桌面总览"
                  : "照片已就绪，可以上传识别"}
          </span>
        </div>
      </div>

      <FixedActionBar>
        <button
          className="mobile-action mobile-action--primary w-full"
          type="button"
          disabled={file === null || stage !== "idle"}
          aria-busy={stage !== "idle"}
          onClick={() => void handleSubmit()}
        >
          {stage === "uploading"
            ? "正在上传…"
            : stage === "recognizing"
              ? "正在识别…"
              : "上传照片并识别"}
        </button>
      </FixedActionBar>
    </section>
  );
}
