import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { confirmIngredients } from "@/src/application/confirm-ingredients";
import { createSession } from "@/src/application/create-session";
import { savePreferences } from "@/src/application/save-preferences";
import { recognizeIngredients } from "@/src/application/recognize-ingredients";
import { createSessionUnitOfWork } from "@/src/application/unit-of-work";
import type {
  QwenVisionCompletionClient,
  QwenVisionCompletionRequest,
  VisionResult,
} from "@/src/providers/vision-provider";
import { images, ingredients, sessions } from "@/src/infrastructure/db/schema";
import { RepositoryVisionImageLoader } from "@/src/infrastructure/providers/repository-vision-image-loader";
import { QwenVisionProvider } from "@/src/infrastructure/providers/qwen-vision-provider";
import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";
import { normalizeImage } from "@/src/infrastructure/uploads/normalize-image";
import { validateImage } from "@/src/infrastructure/uploads/validate-image";
import { uploadSessionImage } from "@/src/application/upload-session-image";
import type { ImageProcessor } from "@/src/application/image-processing-port";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase } from "@/tests/helpers/test-database";

const imageProcessor: ImageProcessor = {
  validate: validateImage,
  normalize: normalizeImage,
};

const uploadLimits = {
  maxBytes: 12 * 1024 * 1024,
  maxPixels: 40_000_000,
  longEdge: 2_048,
};

const modelVisionResult = {
  ingredients: [
    {
      rawName: "二锅头",
      canonicalName: "二锅头",
      category: "spirit" as const,
      brand: null,
      abv: null,
      confidence: 0.92,
      confirmed: false,
    },
    {
      rawName: "苏打水",
      canonicalName: "苏打水",
      category: "mixer" as const,
      brand: null,
      abv: null,
      confidence: 0.95,
      confirmed: false,
    },
  ],
  needsLabelCloseup: true,
  userQuestions: ["请确认酒精度（ABV）。"],
};

class CapturingQwenClient implements QwenVisionCompletionClient {
  readonly requests: QwenVisionCompletionRequest[] = [];

  async complete(request: QwenVisionCompletionRequest): Promise<string> {
    this.requests.push(request);
    return JSON.stringify(modelVisionResult);
  }
}

async function createRealJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 24,
      height: 16,
      channels: 3,
      background: { r: 180, g: 120, b: 80 },
    },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
}

describe("Task 7 to Task 8 real image integration", () => {
  it("passes the normalized JPEG bytes from upload storage into Qwen and reaches READY after confirmation", async () => {
    const database = createTestDatabase();
    const uploadDirectory = mkdtempSync(path.join(tmpdir(), "baijiu-real-vision-upload-"));
    const unitOfWork = createSessionUnitOfWork(database.db);
    const imageStore = new LocalImageStore(uploadDirectory);
    const completionClient = new CapturingQwenClient();
    const provider = new QwenVisionProvider({
      client: completionClient,
      model: "qwen-vision-integration-test",
      imageLoader: new RepositoryVisionImageLoader(unitOfWork.readVision(), imageStore),
    });

    try {
      const fixtures = makeDomainFixtures();
      const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
      const preferences = savePreferences(unitOfWork, {
        sessionId: created.response.session.id,
        requestId: crypto.randomUUID(),
        expectedVersion: 0,
        preferences: fixtures.tasteProfile,
      });
      const originalJpeg = await createRealJpeg();
      const uploaded = await uploadSessionImage(
        unitOfWork,
        imageStore,
        {
          sessionId: created.response.session.id,
          requestId: crypto.randomUUID(),
          expectedVersion: preferences.response.session.version,
          role: "overview",
          filename: "camera.jpg",
          declaredMime: "image/jpeg",
          bytes: originalJpeg,
          limits: uploadLimits,
        },
        imageProcessor,
      );
      const imageId = uploaded.response.data.image.id;
      const storedImage = database.db.select().from(images).all()[0];

      expect(uploaded.response.session).toMatchObject({ state: "SCAN", version: 2 });
      expect(storedImage).toMatchObject({
        id: imageId,
        sessionId: created.response.session.id,
        role: "overview",
        mime: "image/jpeg",
      });
      expect(storedImage?.objectKey).toBe(`${created.response.session.id}/overview-${imageId}.jpg`);
      expect(storedImage?.objectKey).not.toContain(uploadDirectory);

      if (storedImage === undefined) {
        throw new Error("expected uploaded image metadata");
      }
      const savedBytes = await imageStore.read(storedImage.objectKey);
      const recognitionInput = {
        sessionId: created.response.session.id,
        requestId: crypto.randomUUID(),
        expectedVersion: uploaded.response.session.version,
        overviewImageId: imageId,
        labelImageIds: [],
      };

      const recognition = await recognizeIngredients(unitOfWork, provider, recognitionInput);
      const request = completionClient.requests[0];
      const imageContent = request?.images[0];

      expect(request).toBeDefined();
      expect(imageContent).toMatchObject({ imageId, mime: "image/jpeg" });
      if (imageContent === undefined) {
        throw new Error("expected captured Qwen image content");
      }
      const encodedBytes = imageContent.dataUrl.split(",")[1];
      expect(encodedBytes).toBeDefined();
      expect(Buffer.from(encodedBytes ?? "", "base64")).toEqual(Buffer.from(savedBytes));
      expect(Buffer.from(savedBytes).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(recognition.response.session).toMatchObject({ state: "CONFIRM", version: 3 });

      const replay = await recognizeIngredients(unitOfWork, provider, recognitionInput);
      expect(replay.replayed).toBe(true);
      expect(completionClient.requests).toHaveLength(1);

      const confirmedIngredients: VisionResult["ingredients"] =
        recognition.response.data.recognition.ingredients.map((ingredient) => ({
          ...ingredient,
          confirmed: true,
          abv: ingredient.category === "spirit" ? 52 : ingredient.abv,
        }));
      const confirmation = await confirmIngredients(unitOfWork, {
        sessionId: created.response.session.id,
        requestId: crypto.randomUUID(),
        expectedVersion: recognition.response.session.version,
        ingredients: confirmedIngredients,
      });

      expect(confirmation.response.session).toMatchObject({ state: "READY", version: 4 });
      expect(database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "READY",
        version: 4,
      });
      expect(database.db.select().from(ingredients).all()).toHaveLength(2);
    } finally {
      database.cleanup();
      rmSync(uploadDirectory, { recursive: true, force: true });
    }
  });
});
