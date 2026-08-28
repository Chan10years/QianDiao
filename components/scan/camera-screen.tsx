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
    <section className="space-y-6 pb-32">
      <div className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-amber-700">第二步 · 识别</p>
        <h1 className="text-3xl leading-tight font-semibold text-stone-900">拍照桌面材料</h1>
        <p className="leading-7 text-stone-600">
          把酒和想加入的材料放在同一张桌面总览图里。识别结果只作为草稿，下一步可以逐项修改和确认。
        </p>
      </div>

      {errorMessage !== null ? (
        <div
          className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-800"
          role="alert"
        >
          {errorMessage}
        </div>
      ) : null}

      {successMessage !== null ? (
        <p
          className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-800"
          role="status"
        >
          {successMessage}
        </p>
      ) : null}

      <div className="space-y-4 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-stone-200">
        <label
          className="flex min-h-11 cursor-pointer items-center justify-center rounded-2xl border border-dashed border-stone-300 px-5 py-3 text-center font-medium text-stone-800 hover:border-amber-600 hover:bg-amber-50"
          htmlFor="overview-image"
        >
          {file === null ? "打开相机或选择照片" : "替换照片"}
        </label>
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

        {file !== null ? <ImagePreview file={file} /> : null}
      </div>

      <div aria-live="polite" className="min-h-6 text-sm text-stone-600">
        {stage === "uploading" ? "正在上传照片…" : null}
        {stage === "recognizing" ? "正在识别材料…" : null}
      </div>

      <FixedActionBar>
        <button
          className="min-h-11 w-full rounded-2xl bg-stone-900 px-5 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
          type="button"
          disabled={file === null || stage !== "idle"}
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
