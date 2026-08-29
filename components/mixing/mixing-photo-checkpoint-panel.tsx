"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";

import type {
  SessionSnapshot,
  SessionClientLike,
  UploadMixingStepImageResult,
} from "@/src/infrastructure/http/session-client";
import { SessionClientError, sessionImageUrl } from "@/src/infrastructure/http/session-client";

type MixingPhoto = SessionSnapshot["data"]["mixingPhotos"][number];

interface MixingPhotoCheckpointPanelProps {
  sessionId: string;
  expectedVersion: number;
  currentStep: number;
  recipeId: string;
  client: SessionClientLike;
  mixingPhoto?: MixingPhoto;
  onPhotoUploaded?: (result: UploadMixingStepImageResult) => void;
}

/**
 * Legacy checkpoint photo panel.
 *
 * Product Pivot 之后该面板不再出现在任何渲染路径（session-shell / MixingScreen 均不引用），
 * 仅保留旧交互实现与其测试，供历史数据与回滚参考。
 */
export function MixingPhotoCheckpointPanel({
  sessionId,
  expectedVersion,
  currentStep,
  recipeId,
  client,
  mixingPhoto,
  onPhotoUploaded = () => undefined,
}: MixingPhotoCheckpointPanelProps) {
  const [photoPanelOpen, setPhotoPanelOpen] = useState(mixingPhoto === undefined);
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

  async function uploadPhoto(file: File): Promise<void> {
    if (isUploadingPhoto) return;

    setIsUploadingPhoto(true);
    setPhotoError(null);
    try {
      const result = await client.uploadMixingStepImage({
        sessionId,
        expectedVersion,
        recipeId,
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

  return (
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
  );
}
