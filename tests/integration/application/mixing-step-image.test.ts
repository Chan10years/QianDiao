import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { eq } from "drizzle-orm";

import { createSession } from "@/src/application/create-session";
import { getSession } from "@/src/application/get-session";
import { uploadSessionImage } from "@/src/application/upload-session-image";
import type { ImageProcessor } from "@/src/application/image-processing-port";
import { createSessionUnitOfWork } from "@/src/application/unit-of-work";
import type { SessionUnitOfWork } from "@/src/application/unit-of-work";
import { RecipeCandidateSchema } from "@/src/domain/recipe";
import { images, sessions } from "@/src/infrastructure/db/schema";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { normalizeImage } from "@/src/infrastructure/uploads/normalize-image";
import { validateImage } from "@/src/infrastructure/uploads/validate-image";
import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase, type TestDatabase } from "@/tests/helpers/test-database";

const limits = {
  maxBytes: 12 * 1024 * 1024,
  maxPixels: 40_000_000,
  longEdge: 2_048,
};

const imageProcessor: ImageProcessor = {
  validate: validateImage,
  normalize: normalizeImage,
};

async function createJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 8,
      height: 6,
      channels: 3,
      background: { r: 100, g: 160, b: 220 },
    },
  })
    .jpeg()
    .toBuffer();
}

function createMixingContext() {
  const database = createTestDatabase();
  const uploadDirectory = mkdtempSync(path.join(tmpdir(), "baijiu-mixing-photo-"));
  const unitOfWork = createSessionUnitOfWork(database.db);
  const fixtures = makeDomainFixtures();
  const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
  const recipeRepository = new DrizzleRecipeRepository(database.db);
  const recipeSetId = crypto.randomUUID();
  const recipeId = fixtures.ids.recipeIds[0];
  const candidate = RecipeCandidateSchema.parse({
    ...fixtures.recipes[0],
    id: recipeId,
    steps: [
      { order: 1, instruction: "加入冰块并降温。", isPhotoCheckpoint: true },
      { order: 2, instruction: "沿杯壁加入白酒。", isPhotoCheckpoint: false },
    ],
  });

  recipeRepository.createRecipeSet({
    id: recipeSetId,
    sessionId: created.response.session.id,
    sourceMode: "fallback",
  });
  recipeRepository.createRecipe({
    recipeSetId,
    sessionId: created.response.session.id,
    candidate,
  });
  database.db
    .update(sessions)
    .set({ state: "MIXING", version: 1, selectedRecipeId: recipeId, currentStep: 0 })
    .where(eq(sessions.id, created.response.session.id))
    .run();

  return {
    database,
    uploadDirectory,
    unitOfWork,
    store: new LocalImageStore(uploadDirectory),
    sessionId: created.response.session.id,
    recipeId,
  };
}

function closeContext(context: ReturnType<typeof createMixingContext>): void {
  context.database.cleanup();
  rmSync(context.uploadDirectory, { recursive: true, force: true });
}

describe("mixing step image upload", () => {
  it("stores a validated photo for the selected recipe and current checkpoint", async () => {
    const context = createMixingContext();

    try {
      const result = await uploadSessionImage(
        context.unitOfWork,
        context.store,
        {
          sessionId: context.sessionId,
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
          role: "mixing_step",
          recipeId: context.recipeId,
          stepIndex: 0,
          filename: "checkpoint.jpg",
          declaredMime: "image/jpeg",
          bytes: await createJpeg(),
          limits,
        } as unknown as Parameters<typeof uploadSessionImage>[2],
        imageProcessor,
      );

      expect(result.response.data.image).toMatchObject({
        role: "mixing_step",
        mime: "image/jpeg",
      });
      expect(result.response.session).toMatchObject({ state: "MIXING", version: 2 });
      expect(databaseImages(context.database)).toMatchObject([
        {
          sessionId: context.sessionId,
          role: "mixing_step",
          recipeId: context.recipeId,
          stepIndex: 0,
        },
      ]);
      expect(readdirSync(path.join(context.uploadDirectory, context.sessionId))).toHaveLength(1);
    } finally {
      closeContext(context);
    }
  });

  it("returns safe mixing photo metadata in the session snapshot", async () => {
    const context = createMixingContext();

    try {
      await uploadSessionImage(
        context.unitOfWork,
        context.store,
        {
          sessionId: context.sessionId,
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
          role: "mixing_step",
          recipeId: context.recipeId,
          stepIndex: 0,
          filename: "checkpoint.jpg",
          declaredMime: "image/jpeg",
          bytes: await createJpeg(),
          limits,
        } as unknown as Parameters<typeof uploadSessionImage>[2],
        imageProcessor,
      );

      expect(getSession(context.unitOfWork, { sessionId: context.sessionId })).toMatchObject({
        mixingPhotos: [
          {
            role: "mixing_step",
            recipeId: context.recipeId,
            stepIndex: 0,
          },
        ],
      });
      expect(getSession(context.unitOfWork, { sessionId: context.sessionId })).not.toMatchObject({
        mixingPhotos: [{ objectKey: expect.any(String) }],
      });
    } finally {
      closeContext(context);
    }
  });

  it("replaces the current checkpoint photo without leaving an old file", async () => {
    const context = createMixingContext();

    try {
      const first = await uploadPhoto(context, 1, 1);
      const second = await uploadPhoto(context, 2, 2);

      expect(second.response.session.version).toBe(3);
      expect(second.response.data.image.id).toBe(first.response.data.image.id);
      expect(databaseImages(context.database)).toHaveLength(1);
      expect(readdirSync(path.join(context.uploadDirectory, context.sessionId))).toHaveLength(1);
    } finally {
      closeContext(context);
    }
  });

  it("rejects non-checkpoint steps and mismatched mixing ownership", async () => {
    const context = createMixingContext();

    try {
      await expect(uploadPhoto(context, 1, 1)).resolves.toBeDefined();
      await expect(
        uploadSessionImage(
          context.unitOfWork,
          context.store,
          {
            sessionId: context.sessionId,
            requestId: crypto.randomUUID(),
            expectedVersion: 2,
            role: "mixing_step",
            recipeId: context.recipeId,
            stepIndex: 1,
            filename: "not-checkpoint.jpg",
            declaredMime: "image/jpeg",
            bytes: await createJpeg(),
            limits,
          } as unknown as Parameters<typeof uploadSessionImage>[2],
          imageProcessor,
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
      await expect(
        uploadSessionImage(
          context.unitOfWork,
          context.store,
          {
            sessionId: context.sessionId,
            requestId: crypto.randomUUID(),
            expectedVersion: 2,
            role: "mixing_step",
            recipeId: crypto.randomUUID(),
            stepIndex: 0,
            filename: "wrong-recipe.jpg",
            declaredMime: "image/jpeg",
            bytes: await createJpeg(),
            limits,
          } as unknown as Parameters<typeof uploadSessionImage>[2],
          imageProcessor,
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    } finally {
      closeContext(context);
    }
  });

  it("replays an idempotent mixing upload without writing a second file", async () => {
    const context = createMixingContext();
    const requestId = crypto.randomUUID();

    try {
      const input = {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: 1,
        role: "mixing_step" as const,
        recipeId: context.recipeId,
        stepIndex: 0,
        filename: "checkpoint.jpg",
        declaredMime: "image/jpeg",
        bytes: await createJpeg(),
        limits,
      };
      const first = await uploadSessionImage(
        context.unitOfWork,
        context.store,
        input,
        imageProcessor,
      );
      const replay = await uploadSessionImage(
        context.unitOfWork,
        context.store,
        input,
        imageProcessor,
      );

      expect(replay.replayed).toBe(true);
      expect(replay.response).toEqual(first.response);
      expect(databaseImages(context.database)).toHaveLength(1);
      expect(readdirSync(path.join(context.uploadDirectory, context.sessionId))).toHaveLength(1);
    } finally {
      closeContext(context);
    }
  });

  it("rejects a stale mixing upload without replacing the current photo", async () => {
    const context = createMixingContext();

    try {
      const first = await uploadPhoto(context, 1, 1);
      await expect(uploadPhoto(context, 1, 2)).rejects.toMatchObject({
        code: "VERSION_CONFLICT",
      });
      expect(first.response.session.version).toBe(2);
      expect(databaseImages(context.database)).toHaveLength(1);
      expect(readdirSync(path.join(context.uploadDirectory, context.sessionId))).toHaveLength(1);
    } finally {
      closeContext(context);
    }
  });

  it("cleans the stored file when the database transaction fails", async () => {
    const context = createMixingContext();

    try {
      const failingUnitOfWork: SessionUnitOfWork = {
        read: () => context.unitOfWork.read(),
        transaction: () => {
          throw new Error("DATABASE_WRITE_FAILED");
        },
      };
      await expect(
        uploadSessionImage(
          failingUnitOfWork,
          context.store,
          {
            sessionId: context.sessionId,
            requestId: crypto.randomUUID(),
            expectedVersion: 1,
            role: "mixing_step",
            recipeId: context.recipeId,
            stepIndex: 0,
            filename: "checkpoint.jpg",
            declaredMime: "image/jpeg",
            bytes: await createJpeg(),
            limits,
          } as unknown as Parameters<typeof uploadSessionImage>[2],
          imageProcessor,
        ),
      ).rejects.toThrow("DATABASE_WRITE_FAILED");
      expect(existsSync(path.join(context.uploadDirectory, context.sessionId))).toBe(false);
    } finally {
      closeContext(context);
    }
  });
});

async function uploadPhoto(
  context: ReturnType<typeof createMixingContext>,
  expectedVersion: number,
  imageByte: number,
) {
  return uploadSessionImage(
    context.unitOfWork,
    context.store,
    {
      sessionId: context.sessionId,
      requestId: crypto.randomUUID(),
      expectedVersion,
      role: "mixing_step",
      recipeId: context.recipeId,
      stepIndex: 0,
      filename: `checkpoint-${imageByte}.jpg`,
      declaredMime: "image/jpeg",
      bytes: await createJpeg(),
      limits,
    } as unknown as Parameters<typeof uploadSessionImage>[2],
    imageProcessor,
  );
}

function databaseImages(context: TestDatabase) {
  return context.db.select().from(images).all();
}
