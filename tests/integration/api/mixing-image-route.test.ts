import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { createSession } from "@/src/application/create-session";
import { createSessionUnitOfWork } from "@/src/application/unit-of-work";
import { createImageRouteHandlers } from "@/app/api/sessions/[sessionId]/images/route";
import { createImageReadRouteHandler } from "@/app/api/sessions/[sessionId]/images/[imageId]/route";
import { createSessionDetailRouteHandlers } from "@/app/api/sessions/[sessionId]/route";
import { images, sessions } from "@/src/infrastructure/db/schema";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";
import { RecipeCandidateSchema } from "@/src/domain/recipe";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase } from "@/tests/helpers/test-database";

const limits = {
  maxBytes: 12 * 1024 * 1024,
  maxPixels: 40_000_000,
  longEdge: 2_048,
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
  const unitOfWork = createSessionUnitOfWork(database.db);
  const fixtures = makeDomainFixtures();
  const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
  const recipeRepository = new DrizzleRecipeRepository(database.db);
  const recipeSetId = crypto.randomUUID();
  const recipeId = fixtures.ids.recipeIds[0];
  const candidate = RecipeCandidateSchema.parse({
    ...fixtures.recipes[0],
    id: recipeId,
    steps: [{ order: 1, instruction: "加入冰块并降温。", isPhotoCheckpoint: true }],
  });
  recipeRepository.createRecipeSet({
    id: recipeSetId,
    sessionId: created.response.session.id,
    sourceMode: "fallback",
  });
  recipeRepository.createRecipe({ recipeSetId, sessionId: created.response.session.id, candidate });
  database.db
    .update(sessions)
    .set({ state: "MIXING", version: 1, selectedRecipeId: recipeId, currentStep: 0 })
    .where(eq(sessions.id, created.response.session.id))
    .run();
  const uploadDirectory = mkdtempSync(path.join(tmpdir(), "baijiu-mixing-route-"));
  const imageStore = new LocalImageStore(uploadDirectory);

  return {
    database,
    unitOfWork,
    sessionId: created.response.session.id,
    recipeId,
    handlers: createImageRouteHandlers(unitOfWork, imageStore, limits),
    uploadDirectory,
    imageStore,
  };
}

async function requestWithMixingImage(
  sessionId: string,
  recipeId: string,
  bytes: Buffer,
): Promise<Request> {
  const form = new FormData();
  form.set("requestId", crypto.randomUUID());
  form.set("expectedVersion", "1");
  form.set("role", "mixing_step");
  form.set("recipeId", recipeId);
  form.set("stepIndex", "0");
  form.set("file", new File([new Uint8Array(bytes)], "checkpoint.jpg", { type: "image/jpeg" }));
  return new Request(`http://localhost/api/sessions/${sessionId}/images`, {
    method: "POST",
    body: form,
  });
}

describe("mixing image route", () => {
  it("accepts a photo for the current marked mixing step", async () => {
    const context = createMixingContext();

    try {
      const response = await context.handlers.POST(
        await requestWithMixingImage(context.sessionId, context.recipeId, await createJpeg()),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        data: { image: { role: "mixing_step", mime: "image/jpeg" } },
        session: { state: "MIXING", version: 2 },
      });
      expect(context.database.db.select().from(images).all()).toHaveLength(1);

      const snapshotResponse = await createSessionDetailRouteHandlers(context.unitOfWork).GET(
        new Request("http://localhost"),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      const snapshotBody = (await snapshotResponse.json()) as {
        data: { mixingPhotos: Array<Record<string, unknown>> };
      };
      expect(snapshotBody.data.mixingPhotos).toHaveLength(1);
      expect(snapshotBody.data.mixingPhotos[0]).not.toHaveProperty("objectKey");
      expect(JSON.stringify(snapshotBody.data.mixingPhotos[0])).not.toContain(
        context.uploadDirectory,
      );
    } finally {
      context.database.cleanup();
      rmSync(context.uploadDirectory, { recursive: true, force: true });
    }
  });

  it("serves a persisted image only through the owning session route", async () => {
    const context = createMixingContext();

    try {
      const uploadResponse = await context.handlers.POST(
        await requestWithMixingImage(context.sessionId, context.recipeId, await createJpeg()),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      const uploadBody = (await uploadResponse.json()) as {
        data: { image: { id: string } };
      };
      const read = createImageReadRouteHandler(context.unitOfWork, context.imageStore);
      const response = await read(new Request("http://localhost"), {
        params: Promise.resolve({
          sessionId: context.sessionId,
          imageId: uploadBody.data.image.id,
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);

      const wrongOwner = await read(new Request("http://localhost"), {
        params: Promise.resolve({
          sessionId: "99999999-9999-4999-8999-999999999999",
          imageId: uploadBody.data.image.id,
        }),
      });
      expect(wrongOwner.status).toBe(404);
    } finally {
      context.database.cleanup();
      rmSync(context.uploadDirectory, { recursive: true, force: true });
    }
  });
});
