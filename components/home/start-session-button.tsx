"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { z } from "zod";

import { SuccessEnvelopeSchema } from "@/src/domain/api";
import { createRequestId } from "@/src/infrastructure/http/session-client";

const CreateSessionResponseSchema = SuccessEnvelopeSchema(
  z.object({ created: z.literal(true) }).strict(),
);

const CreateSessionErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

const DEFAULT_ERROR_MESSAGE = "创建会话失败，请重试";

export interface StartSessionButtonProps {
  fetcher?: typeof fetch;
}

export function StartSessionButton({ fetcher }: StartSessionButtonProps) {
  const router = useRouter();
  const [isStarting, setIsStarting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 一次"尚未确认成功的开始调饮意图"保留同一个 requestId：
  // 网络/服务器失败后重试继续复用，成功跳转后生命周期结束。
  const pendingRequestIdRef = useRef<string | null>(null);

  async function createSession(requestId: string): Promise<string> {
    const request = fetcher ?? globalThis.fetch.bind(globalThis);
    const response = await request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId }),
      cache: "no-store",
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const parsedError = CreateSessionErrorSchema.safeParse(body);
      if (parsedError.success) {
        throw new Error(parsedError.data.error.message);
      }
      throw new Error(DEFAULT_ERROR_MESSAGE);
    }

    try {
      const parsed = CreateSessionResponseSchema.parse(body);
      return parsed.session.id;
    } catch {
      throw new Error("服务器响应无效，请重试");
    }
  }

  async function handleStart() {
    if (isStarting) return;

    setIsStarting(true);
    setErrorMessage(null);
    try {
      const requestId = pendingRequestIdRef.current ?? createRequestId();
      pendingRequestIdRef.current = requestId;
      const sessionId = await createSession(requestId);
      // 成功拿到 Session，requestId 生命周期结束；保持按钮禁用直到跳转完成。
      pendingRequestIdRef.current = null;
      router.push(`/session/${sessionId}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : DEFAULT_ERROR_MESSAGE);
      setIsStarting(false);
    }
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={handleStart}
        disabled={isStarting}
        className="w-full rounded-2xl bg-amber-600 px-6 py-4 text-base font-semibold text-white shadow-sm transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isStarting ? "正在创建调饮会话…" : "开始调饮"}
      </button>
      {errorMessage !== null ? (
        <div className="mobile-notice mobile-notice--error" role="alert">
          <span className="mobile-notice__label">创建没有完成</span>
          <span>{errorMessage}</span>
        </div>
      ) : null}
    </div>
  );
}
