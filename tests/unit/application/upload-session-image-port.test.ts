import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { uploadSessionImage } from "@/src/application/upload-session-image";
import type {
  SessionTransactionRepository,
  SessionUnitOfWork,
} from "@/src/application/unit-of-work";
import type { ImageStore } from "@/src/providers/image-store";
import type { IdempotencyRecord, SessionRecord } from "@/src/repositories/session-repository";

const limits = {
  maxBytes: 12 * 1024 * 1024,
  maxPixels: 40_000_000,
  longEdge: 2_048,
};

async function createPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 4,
      height: 3,
      channels: 4,
      background: { r: 100, g: 160, b: 220, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe("uploadSessionImage application port", () => {
  it("uses the transaction repository port without a concrete database handle", async () => {
    const sessionId = randomUUID();
    const requestId = randomUUID();
    let session: SessionRecord = {
      id: sessionId,
      state: "SCAN",
      version: 1,
      preferences: null,
      selectedRecipeId: null,
      currentStep: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const idempotency = new Map<string, IdempotencyRecord>();
    const images: string[] = [];

    const repository: SessionTransactionRepository = {
      create: () => {
        throw new Error("not-used");
      },
      findById: () => session,
      acquireSessionMutationLease: () => ({ status: "acquired", session }),
      assertSessionMutationLease: () => undefined,
      renewSessionMutationLease: () => undefined,
      releaseSessionMutationLease: () => undefined,
      updateVersion: (input) => {
        if (input.expectedVersion !== session.version) {
          throw new Error("unexpected version");
        }
        session = { ...session, version: session.version + 1 };
        return session;
      },
      saveIdempotencyRecord: (input) => {
        const record: IdempotencyRecord = {
          ...input,
          leaseOwner: input.leaseOwner ?? null,
          leaseExpiresAt: input.leaseExpiresAt ?? null,
          createdAt: new Date(),
        };
        idempotency.set(input.requestId, record);
        return record;
      },
      findIdempotencyRecord: (_sessionId, candidateRequestId) =>
        idempotency.get(candidateRequestId) ?? null,
      findIdempotencyRecordByRequestId: (candidateRequestId) =>
        idempotency.get(candidateRequestId) ?? null,
      createImage: (input) => {
        images.push(input.id);
        return {
          ...input,
          recipeId: input.recipeId ?? null,
          stepIndex: input.stepIndex ?? null,
          createdAt: new Date(),
        };
      },
      findImageById: () => null,
      updateImage: () => {
        throw new Error("IMAGE_UPDATE_NOT_USED");
      },
      findMixingStepImage: () => null,
      listImagesBySession: () => [],
      findRecipeById: () => null,
    };
    const unitOfWork: SessionUnitOfWork = {
      read: () => repository,
      transaction: (operation) => operation(repository),
    };
    const store: ImageStore = {
      save: async ({ sessionId: savedSessionId, imageId }) => ({
        objectKey: `${savedSessionId}/overview-${imageId}.jpg`,
      }),
      delete: async () => undefined,
    };
    let validationCalls = 0;
    let normalizationCalls = 0;
    const imageProcessor = {
      validate: async () => {
        validationCalls += 1;
        return {
          bytes: Buffer.from([1]),
          mime: "image/png" as const,
          width: 4,
          height: 3,
        };
      },
      normalize: async () => {
        normalizationCalls += 1;
        return {
          bytes: Buffer.from([2]),
          mime: "image/jpeg" as const,
          width: 2,
          height: 2,
        };
      },
    };

    const result = await uploadSessionImage(
      unitOfWork,
      store,
      {
        sessionId,
        requestId,
        expectedVersion: 1,
        role: "overview",
        filename: "valid.png",
        declaredMime: "image/png",
        bytes: await createPng(),
        limits,
      },
      imageProcessor,
    );

    expect(result.replayed).toBe(false);
    expect(validationCalls).toBe(1);
    expect(normalizationCalls).toBe(1);
    expect(result.response.data.image).toMatchObject({ width: 2, height: 2 });
    expect(images).toHaveLength(1);
    expect(session.version).toBe(2);
  });
});
