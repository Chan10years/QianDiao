"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { FixedActionBar } from "@/components/session/fixed-action-bar";
import type { RecipeDisplay } from "@/src/domain/recipe";
import {
  SessionClientError,
  sessionImageUrl,
  type AdvanceMixingResult,
  type SessionSnapshot,
  type SessionClientLike,
  type UploadMixingStepImageResult,
} from "@/src/infrastructure/http/session-client";

type MixingPhoto = SessionSnapshot["data"]["mixingPhotos"][number];

interface MixingScreenProps {
  sessionId: string;
  expectedVersion: number;
  currentStep: number | null;
  recipe: RecipeDisplay;
  client: SessionClientLike;
  onAdvanced: (result: AdvanceMixingResult) => void;
  mixingPhoto?: MixingPhoto;
  onPhotoUploaded?: (result: UploadMixingStepImageResult) => void;
}

export function MixingScreen({
  sessionId,
  expectedVersion,
  currentStep,
  recipe,
  client,
  onAdvanced,
  mixingPhoto,
  onPhotoUploaded = () => undefined,
}: MixingScreenProps) {
  const step = currentStep === null ? undefined : recipe.steps[currentStep];
  const isLastStep = currentStep !== null && currentStep === recipe.steps.length - 1;
  const isPhotoCheckpoint = step?.isPhotoCheckpoint === true;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [photoPanelOpen, setPhotoPanelOpen] = useState(
    isPhotoCheckpoint && mixingPhoto === undefined,
  );
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectedFile === null) {
      const clearPreviewTimer = window.setTimeout(() => setLocalPreviewUrl(null), 0);
      return () => window.clearTimeout(clearPreviewTimer);
    }

    const objectUrl = URL.createObjectURL(selectedFile);
    const updatePreviewTimer = window.setTimeout(() => setLocalPreviewUrl(objectUrl), 0);
    return () => {
      window.clearTimeout(updatePreviewTimer);
      URL.revokeObjectURL(objectUrl);
    };
  }, [selectedFile]);

  async function handleAction(action: "ADVANCE_MIXING" | "BACK_MIXING") {
    if (isSubmitting || currentStep === null) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await client.advanceMixing({
        sessionId,
        expectedVersion,
        action,
      });
      onAdvanced(result);
    } catch (error) {
      setErrorMessage(error instanceof SessionClientError ? error.message : "步骤更新失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function uploadPhoto(file: File): Promise<void> {
    if (isUploadingPhoto || currentStep === null) return;

    setIsUploadingPhoto(true);
    setPhotoError(null);
    try {
      const result = await client.uploadMixingStepImage({
        sessionId,
        expectedVersion,
        recipeId: recipe.id,
        stepIndex: currentStep,
        file,
      });
      onPhotoUploaded(result);
      setSelectedFile(null);
      setPhotoPanelOpen(false);
    } catch (error) {
      setPhotoError(error instanceof SessionClientError ? error.message : "照片上传失败，请重试");
    } finally {
      setIsUploadingPhoto(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const [file] = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (file === undefined) return;
    setSelectedFile(file);
    void uploadPhoto(file);
  }

  if (step === undefined || currentStep === null || currentStep < 0) {
    return (
      <section role="alert" className="rounded-3xl bg-white p-6 text-red-800 shadow-sm">
        当前步骤无法恢复，请重新加载服务端会话。
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <div className="space-y-3 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-stone-200">
        <p className="text-sm font-medium tracking-wide text-amber-700">分步调饮</p>
        <h1 className="text-3xl leading-tight font-semibold text-stone-900">
          第 {currentStep + 1} 步：{step.instruction}
        </h1>
        <p className="text-sm text-stone-600">
          共 {recipe.steps.length} 步 · 当前只显示服务端记录的这一处操作
        </p>
      </div>

      {errorMessage !== null ? (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="space-y-5 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-stone-200">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">本配方用量</h2>
          <ul className="mt-2 space-y-1 text-sm leading-6 text-stone-700">
            {recipe.materials.map((material) => (
              <li key={`${material.name}-${material.amountMl}`}>
                {material.name} · {material.amountMl} {material.unit}
              </li>
            ))}
          </ul>
        </div>
        <p className="rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          完成当前操作后再进入下一步。普通步骤不要求拍照。
        </p>
        <button
          type="button"
          className="min-h-11 w-full rounded-2xl border border-stone-300 px-5 py-3 text-base font-semibold text-stone-800"
          aria-expanded={showHelp}
          onClick={() => setShowHelp((visible) => !visible)}
        >
          遇到问题
        </button>
        {showHelp ? (
          <p className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm leading-6 text-stone-700">
            如果材料状态与步骤不符，请暂停操作并核对材料和用量；确认后可从当前步骤继续，或返回上一步。
          </p>
        ) : null}
      </div>

      {isPhotoCheckpoint ? (
        <section
          className="space-y-4 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-amber-200"
          aria-labelledby="mixing-photo-title"
        >
          {photoPanelOpen ? (
            <>
              <div className="space-y-2">
                <p className="text-sm font-medium tracking-wide text-amber-700">关键节点记录</p>
                <h2 id="mixing-photo-title" className="text-2xl font-semibold text-stone-900">
                  拍照专页
                </h2>
                <p className="text-sm leading-6 text-stone-600">
                  第 {currentStep + 1} 步：请拍下当前材料状态，方便稍后回看这一步的变化。
                </p>
              </div>
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                aria-label="拍摄关键步骤照片"
                onChange={handleFileChange}
              />
              {localPreviewUrl !== null ? (
                <div className="space-y-2">
                  <img
                    src={localPreviewUrl}
                    alt="关键步骤照片本地预览"
                    className="max-h-64 w-full rounded-2xl object-cover"
                  />
                  <p className="text-sm text-stone-600">
                    {isUploadingPhoto ? "正在上传关键步骤照片…" : "已选择照片，可重新拍摄替换。"}
                  </p>
                </div>
              ) : null}
              {photoError !== null ? (
                <p role="alert" className="rounded-2xl bg-red-50 p-4 text-sm text-red-800">
                  {photoError}
                </p>
              ) : null}
              <button
                type="button"
                className="min-h-14 w-full rounded-2xl bg-stone-900 px-5 py-4 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
                disabled={isUploadingPhoto}
                onClick={() => fileInputRef.current?.click()}
              >
                {isUploadingPhoto
                  ? "正在上传…"
                  : selectedFile === null
                    ? "拍摄关键步骤"
                    : "重拍关键步骤"}
              </button>
              {photoError !== null && selectedFile !== null ? (
                <button
                  type="button"
                  className="min-h-11 w-full rounded-2xl border border-stone-300 px-4 py-3 text-sm font-semibold text-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isUploadingPhoto}
                  onClick={() => void uploadPhoto(selectedFile)}
                >
                  重试上传
                </button>
              ) : null}
              <button
                type="button"
                className="min-h-11 w-full rounded-2xl px-4 py-2 text-sm font-semibold text-stone-500 underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isUploadingPhoto}
                onClick={() => {
                  setPhotoPanelOpen(false);
                  setPhotoError(null);
                }}
              >
                暂时跳过
              </button>
            </>
          ) : mixingPhoto !== undefined ? (
            <>
              <div className="space-y-2">
                <h2 id="mixing-photo-title" className="text-lg font-semibold text-stone-900">
                  已保存关键步骤照片
                </h2>
                <img
                  src={sessionImageUrl(sessionId, mixingPhoto.imageId, expectedVersion)}
                  alt="已保存的关键步骤照片"
                  className="max-h-64 w-full rounded-2xl object-cover"
                />
              </div>
              <button
                type="button"
                className="min-h-11 w-full rounded-2xl border border-stone-300 px-4 py-3 text-sm font-semibold text-stone-800"
                onClick={() => {
                  setPhotoPanelOpen(true);
                  setPhotoError(null);
                }}
              >
                替换照片
              </button>
            </>
          ) : (
            <>
              <h2 id="mixing-photo-title" className="text-lg font-semibold text-stone-900">
                关键节点照片可选
              </h2>
              <p className="text-sm leading-6 text-stone-600">
                你已暂时跳过拍照，仍可直接完成当前调饮步骤。
              </p>
              <button
                type="button"
                className="min-h-11 rounded-2xl border border-stone-300 px-4 py-3 text-sm font-semibold text-stone-800"
                onClick={() => setPhotoPanelOpen(true)}
              >
                补拍关键步骤
              </button>
            </>
          )}
        </section>
      ) : null}

      {!photoPanelOpen ? (
        <FixedActionBar>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className="min-h-11 rounded-2xl border border-stone-300 px-4 py-3 text-base font-semibold text-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isSubmitting || currentStep === 0}
              onClick={() => void handleAction("BACK_MIXING")}
            >
              返回上一步
            </button>
            <button
              type="button"
              className="min-h-11 rounded-2xl bg-stone-900 px-4 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
              disabled={isSubmitting}
              onClick={() => void handleAction("ADVANCE_MIXING")}
            >
              {isSubmitting ? "正在保存…" : isLastStep ? "完成最后一步" : "下一步"}
            </button>
          </div>
        </FixedActionBar>
      ) : null}
    </section>
  );
}
