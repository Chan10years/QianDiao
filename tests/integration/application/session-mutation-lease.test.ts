import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { createSession } from "@/src/application/create-session";
import { recognizeIngredients } from "@/src/application/recognize-ingredients";
import { savePreferences } from "@/src/application/save-preferences";
import { uploadSessionImage } from "@/src/application/upload-session-image";
import { createSessionUnitOfWork } from "@/src/application/unit-of-work";
import type { ImageProcessor } from "@/src/application/image-processing-port";
import { createDatabase } from "@/src/infrastructure/db/client";
import { images, sessions } from "@/src/infrastructure/db/schema";
import { normalizeImage } from "@/src/infrastructure/uploads/normalize-image";
import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";
import { validateImage } from "@/src/infrastructure/uploads/validate-image";
import type { VisionProvider, VisionResult } from "@/src/providers/vision-provider";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase } from "@/tests/helpers/test-database";

const visionResult: VisionResult = {
  ingredients: [
    {
      rawName: "二锅头",
      canonicalName: "白酒",
      category: "spirit",
      brand: null,
      abv: null,
      confidence: 0.9,
      confirmed: false,
    },
  ],
  needsLabelCloseup: true,
  userQuestions: ["请确认酒精度（ABV）。"],
  sourceMode: "fallback",
};

class BlockingVisionProvider implements VisionProvider {
  calls = 0;
  private releaseCall: (() => void) | null = null;
  private readonly pendingCall = new Promise<void>((resolve) => {
    this.releaseCall = resolve;
  });

  async recognize(): Promise<VisionResult> {
    this.calls += 1;
    await this.pendingCall;
    return visionResult;
  }

  release(): void {
    this.releaseCall?.();
  }
}

class ImmediateVisionProvider implements VisionProvider {
  calls = 0;

  async recognize(): Promise<VisionResult> {
    this.calls += 1;
    return visionResult;
  }
}

const imageProcessor: ImageProcessor = {
  validate: validateImage,
  normalize: normalizeImage,
};

async function createJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 16,
      height: 12,
      channels: 3,
      background: { r: 120, g: 140, b: 180 },
    },
  })
    .jpeg()
    .toBuffer();
}

function createScanContext() {
  const database = createTestDatabase();
  const unitOfWork = createSessionUnitOfWork(database.db);
  const fixtures = makeDomainFixtures();
  const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
  const preferences = savePreferences(unitOfWork, {
    sessionId: created.response.session.id,
    requestId: crypto.randomUUID(),
    expectedVersion: 0,
    preferences: fixtures.tasteProfile,
  });
  const overviewImageId = crypto.randomUUID();

  database.db
    .insert(images)
    .values({
      id: overviewImageId,
      sessionId: created.response.session.id,
      role: "overview",
      objectKey: `${created.response.session.id}/overview-${overviewImageId}.jpg`,
      mime: "image/jpeg",
      width: 100,
      height: 80,
    })
    .run();

  return {
    database,
    unitOfWork,
    sessionId: created.response.session.id,
    expectedVersion: preferences.response.session.version,
    overviewImageId,
  };
}

describe("persistent session mutation lease", () => {
  it("does not call the Provider when the session version advances after precheck", async () => {
    const context = createScanContext();
    const provider = new ImmediateVisionProvider();
    const input = {
      sessionId: context.sessionId,
      requestId: crypto.randomUUID(),
      expectedVersion: context.expectedVersion,
      overviewImageId: context.overviewImageId,
      labelImageIds: [],
    };
    let injectVersionAdvance = true;
    const racingUnitOfWork = {
      ...context.unitOfWork,
      transactionVision<T>(
        operation: Parameters<typeof context.unitOfWork.transactionVision<T>>[0],
      ): T {
        if (injectVersionAdvance) {
          injectVersionAdvance = false;
          context.database.sqlite
            .prepare(
              "UPDATE sessions SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
            )
            .run(Date.now(), context.sessionId, context.expectedVersion);
        }
        return context.unitOfWork.transactionVision(operation);
      },
    };

    try {
      await expect(recognizeIngredients(racingUnitOfWork, provider, input)).rejects.toMatchObject({
        code: "VERSION_CONFLICT",
      });
      expect(provider.calls).toBe(0);
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        version: context.expectedVersion + 1,
        state: "SCAN",
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects a real upload while recognition owns the session lease without advancing version", async () => {
    const context = createScanContext();
    const secondDatabase = createDatabase(context.database.databasePath);
    const secondUnitOfWork = createSessionUnitOfWork(secondDatabase.db);
    const uploadDirectory = mkdtempSync(path.join(tmpdir(), "baijiu-session-lease-upload-"));
    const imageStore = new LocalImageStore(uploadDirectory);
    const provider = new BlockingVisionProvider();
    const recognition = recognizeIngredients(context.unitOfWork, provider, {
      sessionId: context.sessionId,
      requestId: crypto.randomUUID(),
      expectedVersion: context.expectedVersion,
      overviewImageId: context.overviewImageId,
      labelImageIds: [],
    });

    try {
      await Promise.resolve();
      expect(provider.calls).toBe(1);

      await expect(
        uploadSessionImage(
          secondUnitOfWork,
          imageStore,
          {
            sessionId: context.sessionId,
            requestId: crypto.randomUUID(),
            expectedVersion: context.expectedVersion,
            role: "overview",
            filename: "replacement.jpg",
            declaredMime: "image/jpeg",
            bytes: await createJpeg(),
          },
          imageProcessor,
        ),
      ).rejects.toMatchObject({ code: "SESSION_MUTATION_IN_PROGRESS" });

      expect(secondUnitOfWork.read().findById(context.sessionId)).toMatchObject({
        version: context.expectedVersion,
        state: "SCAN",
      });
      expect(context.database.db.select().from(images).all()).toHaveLength(1);
      expect(readdirSync(uploadDirectory)).toHaveLength(0);

      provider.release();
      await expect(recognition).resolves.toMatchObject({
        response: { session: { state: "CONFIRM", version: context.expectedVersion + 1 } },
      });
    } finally {
      provider.release();
      await Promise.allSettled([recognition]);
      secondDatabase.close();
      context.database.cleanup();
      rmSync(uploadDirectory, { recursive: true, force: true });
    }
  });
});
