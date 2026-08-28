import { describe, expect, it, vi } from "vitest";

import { SessionClient, SessionClientError } from "@/src/infrastructure/http/session-client";

const sessionResponse = {
  data: {
    preferences: { sweetness: 4, acidity: 2, alcoholIntensity: 3, body: 2 },
    ingredients: [],
  },
  session: {
    id: "123e4567-e89b-12d3-a456-426614174000",
    state: "SCAN",
    version: 1,
  },
};

const preferenceResponse = {
  data: { preferences: sessionResponse.data.preferences },
  session: sessionResponse.session,
};

describe("SessionClient", () => {
  it("calls a browser-bound fetch function with its original receiver", async () => {
    const browserWindow = globalThis;
    const browserFetch: typeof fetch = function (this: unknown) {
      if (this !== browserWindow) {
        throw new TypeError("Illegal invocation");
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...sessionResponse,
            data: { ...sessionResponse.data, selectedRecipeId: null, currentStep: null },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = browserFetch;
    try {
      const client = new SessionClient();

      await expect(client.getSession(sessionResponse.session.id)).resolves.toMatchObject({
        session: { state: "SCAN" },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("reuses a failed mutation requestId and rotates it only after success", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: "稍后重试",
              retryable: true,
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(preferenceResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...preferenceResponse,
            session: { ...sessionResponse.session, version: 2 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    const client = new SessionClient({
      fetcher,
      requestIdFactory: vi.fn(() => crypto.randomUUID()),
    });
    const input = {
      sessionId: sessionResponse.session.id,
      expectedVersion: 0,
      preferences: {
        sweetness: 4 as const,
        acidity: 2 as const,
        alcoholIntensity: 3 as const,
        body: 2 as const,
      },
    };

    await expect(client.savePreferences(input)).rejects.toThrow("稍后重试");
    await client.savePreferences(input);
    await client.savePreferences({
      ...input,
      expectedVersion: 1,
      preferences: { ...input.preferences, body: 4 },
    });

    const firstBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    const thirdBody = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));

    expect(secondBody.requestId).toBe(firstBody.requestId);
    expect(thirdBody.requestId).not.toBe(secondBody.requestId);
  });

  it("rotates the mutation requestId after a known version conflict", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "VERSION_CONFLICT",
              message: "会话版本已过期，请重新加载",
              retryable: true,
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(preferenceResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new SessionClient({
      fetcher,
      requestIdFactory: vi
        .fn()
        .mockReturnValueOnce("request-before-conflict")
        .mockReturnValueOnce("request-after-conflict"),
    });
    const input = {
      sessionId: sessionResponse.session.id,
      expectedVersion: 0,
      preferences: {
        sweetness: 4 as const,
        acidity: 2 as const,
        alcoholIntensity: 3 as const,
        body: 2 as const,
      },
    };

    await expect(client.savePreferences(input)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    await client.savePreferences({ ...input, expectedVersion: 1 });

    const firstBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(secondBody.requestId).not.toBe(firstBody.requestId);
  });

  it("maps a malformed successful response to a stable client error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...sessionResponse,
          data: { ...sessionResponse.data, ingredients: [{ unexpected: "payload" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new SessionClient({ fetcher });

    try {
      await client.getSession(sessionResponse.session.id);
      throw new Error("expected malformed response to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionClientError);
      expect(error).toMatchObject({
        code: "INVALID_RESPONSE",
        message: "服务器响应无效，请重试",
      });
      expect((error as Error).message).not.toContain("unexpected");
      expect((error as Error).message).not.toContain("path");
      expect((error as Error & { cause?: unknown }).cause).toBeDefined();
    }
  });

  it("reuses the recognition requestId after a retryable recognition failure", async () => {
    const recognitionResponse = {
      data: {
        recognition: {
          ingredients: [
            {
              rawName: "苏打水",
              canonicalName: "苏打水",
              category: "mixer",
              brand: null,
              abv: null,
              confidence: 0.9,
              confirmed: false,
            },
          ],
          needsLabelCloseup: false,
          userQuestions: [],
          sourceMode: "fallback",
        },
      },
      session: { ...sessionResponse.session, state: "CONFIRM", version: 3 },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: "识别服务暂时不可用，请重试",
              retryable: true,
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(recognitionResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new SessionClient({
      fetcher,
      requestIdFactory: vi.fn(() => "recognition-request-id"),
    });
    const input = {
      sessionId: sessionResponse.session.id,
      expectedVersion: 2,
      overviewImageId: "223e4567-e89b-12d3-a456-426614174000",
      labelImageIds: [],
    };

    await expect(client.recognizeIngredients(input)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    await client.recognizeIngredients(input);

    const firstBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(secondBody.requestId).toBe(firstBody.requestId);
    expect(secondBody.expectedVersion).toBe(2);
  });

  it("uses fresh upload and recognition requestIds after a recognition version conflict", async () => {
    const uploadImage = {
      id: "223e4567-e89b-12d3-a456-426614174000",
      role: "overview",
      mime: "image/jpeg",
      width: 1200,
      height: 800,
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { image: uploadImage },
            session: { ...sessionResponse.session, version: 2 },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "VERSION_CONFLICT",
              message: "会话版本已过期，请重新加载",
              retryable: true,
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { image: { ...uploadImage, id: "323e4567-e89b-12d3-a456-426614174000" } },
            session: { ...sessionResponse.session, version: 4 },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              recognition: {
                ingredients: [
                  {
                    rawName: "苏打水",
                    canonicalName: "苏打水",
                    category: "mixer",
                    brand: null,
                    abv: null,
                    confidence: 0.9,
                    confirmed: false,
                  },
                ],
                needsLabelCloseup: false,
                userQuestions: [],
                sourceMode: "fallback",
              },
            },
            session: { ...sessionResponse.session, state: "CONFIRM", version: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new SessionClient({
      fetcher,
      requestIdFactory: vi
        .fn()
        .mockReturnValueOnce("upload-before-conflict")
        .mockReturnValueOnce("recognition-before-conflict")
        .mockReturnValueOnce("upload-after-conflict")
        .mockReturnValueOnce("recognition-after-conflict"),
    });
    const file = new File(["jpeg"], "桌面.jpg", { type: "image/jpeg" });

    await client.uploadOverviewImage({
      sessionId: sessionResponse.session.id,
      expectedVersion: 1,
      file,
    });
    await expect(
      client.recognizeIngredients({
        sessionId: sessionResponse.session.id,
        expectedVersion: 2,
        overviewImageId: uploadImage.id,
        labelImageIds: [],
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await client.uploadOverviewImage({
      sessionId: sessionResponse.session.id,
      expectedVersion: 3,
      file,
    });
    await client.recognizeIngredients({
      sessionId: sessionResponse.session.id,
      expectedVersion: 4,
      overviewImageId: "323e4567-e89b-12d3-a456-426614174000",
      labelImageIds: [],
    });

    const firstUploadBody = fetcher.mock.calls[0]?.[1]?.body;
    const firstRecognitionBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    const secondUploadBody = fetcher.mock.calls[2]?.[1]?.body;
    const secondRecognitionBody = JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body));
    expect(firstUploadBody).toBeInstanceOf(FormData);
    expect(secondUploadBody).toBeInstanceOf(FormData);
    expect((secondUploadBody as FormData).get("requestId")).not.toBe(
      (firstUploadBody as FormData).get("requestId"),
    );
    expect(firstRecognitionBody.requestId).toBe("recognition-before-conflict");
    expect(secondRecognitionBody.requestId).toBe("recognition-after-conflict");
    expect(secondRecognitionBody.requestId).not.toBe(firstRecognitionBody.requestId);
    expect(secondRecognitionBody.expectedVersion).toBe(4);
    expect(secondRecognitionBody.overviewImageId).toBe("323e4567-e89b-12d3-a456-426614174000");
  });

  it("sends recipe selection and mixing actions with the server version", async () => {
    const recipeId = "223e4567-e89b-12d3-a456-426614174000";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { recipeId, currentStep: 0, totalSteps: 2, warningAcknowledged: true },
            session: { ...sessionResponse.session, state: "MIXING", version: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { action: "ADVANCE_MIXING", currentStep: 1, totalSteps: 2 },
            session: { ...sessionResponse.session, state: "MIXING", version: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new SessionClient({
      fetcher,
      requestIdFactory: vi
        .fn()
        .mockReturnValueOnce("select-request")
        .mockReturnValueOnce("advance-request"),
    });

    await client.selectRecipe({
      sessionId: sessionResponse.session.id,
      expectedVersion: 2,
      recipeId,
      warningAcknowledged: true,
    });
    await client.advanceMixing({
      sessionId: sessionResponse.session.id,
      expectedVersion: 3,
      action: "ADVANCE_MIXING",
    });

    const selectionBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    const advanceBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(selectionBody).toMatchObject({
      requestId: "select-request",
      expectedVersion: 2,
      recipeId,
      warningAcknowledged: true,
    });
    expect(advanceBody).toMatchObject({
      requestId: "advance-request",
      expectedVersion: 3,
      action: "ADVANCE_MIXING",
    });
  });

  it("reuses an advance requestId after a retryable failure and rotates it after success", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: "稍后重试",
              retryable: true,
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { action: "ADVANCE_MIXING", currentStep: 1, totalSteps: 2 },
            session: { ...sessionResponse.session, state: "MIXING", version: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { action: "BACK_MIXING", currentStep: 0, totalSteps: 2 },
            session: { ...sessionResponse.session, state: "MIXING", version: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new SessionClient({
      fetcher,
      requestIdFactory: vi
        .fn()
        .mockReturnValueOnce("advance-before-retry")
        .mockReturnValueOnce("advance-after-success"),
    });
    const firstInput = {
      sessionId: sessionResponse.session.id,
      expectedVersion: 1,
      action: "ADVANCE_MIXING" as const,
    };

    await expect(client.advanceMixing(firstInput)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    await client.advanceMixing(firstInput);
    await client.advanceMixing({ ...firstInput, expectedVersion: 2, action: "BACK_MIXING" });

    const firstBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    const thirdBody = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(secondBody.requestId).toBe(firstBody.requestId);
    expect(thirdBody.requestId).not.toBe(secondBody.requestId);
    expect(thirdBody.expectedVersion).toBe(2);
  });

  it("maps malformed successful mixing responses to the stable client error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { action: "ADVANCE_MIXING" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new SessionClient({ fetcher });

    await expect(
      client.advanceMixing({
        sessionId: sessionResponse.session.id,
        expectedVersion: 1,
        action: "ADVANCE_MIXING",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", message: "服务器响应无效，请重试" });
  });

  it("reuses a mixing photo requestId after an upload failure and sends the step contract", async () => {
    const image = {
      id: "223e4567-e89b-12d3-a456-426614174000",
      role: "mixing_step",
      mime: "image/jpeg",
      width: 1200,
      height: 800,
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "PROVIDER_UNAVAILABLE", message: "稍后重试", retryable: true },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { image },
            session: { ...sessionResponse.session, state: "MIXING", version: 3 },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new SessionClient({
      fetcher,
      requestIdFactory: vi.fn(() => "mixing-photo-request"),
    });
    const input = {
      sessionId: sessionResponse.session.id,
      expectedVersion: 2,
      recipeId: "323e4567-e89b-12d3-a456-426614174000",
      stepIndex: 0,
      file: new File(["jpeg"], "checkpoint.jpg", { type: "image/jpeg" }),
    };

    await expect(client.uploadMixingStepImage(input)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    await client.uploadMixingStepImage(input);

    const firstBody = fetcher.mock.calls[0]?.[1]?.body;
    const secondBody = fetcher.mock.calls[1]?.[1]?.body;
    expect(firstBody).toBeInstanceOf(FormData);
    expect(secondBody).toBeInstanceOf(FormData);
    expect((secondBody as FormData).get("requestId")).toBe(
      (firstBody as FormData).get("requestId"),
    );
    expect((secondBody as FormData).get("role")).toBe("mixing_step");
    expect((secondBody as FormData).get("recipeId")).toBe(input.recipeId);
    expect((secondBody as FormData).get("stepIndex")).toBe("0");
    expect((secondBody as FormData).get("expectedVersion")).toBe("2");
  });
});
