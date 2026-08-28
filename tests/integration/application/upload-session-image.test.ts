import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { createSession } from "@/src/application/create-session";
import { savePreferences } from "@/src/application/save-preferences";
import type { ImageProcessor } from "@/src/application/image-processing-port";
import { uploadSessionImage } from "@/src/application/upload-session-image";
import { createSessionUnitOfWork, type SessionUnitOfWork } from "@/src/application/unit-of-work";
import { createDatabase } from "@/src/infrastructure/db/client";
import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";
import { normalizeImage } from "@/src/infrastructure/uploads/normalize-image";
import { validateImage } from "@/src/infrastructure/uploads/validate-image";
import { images } from "@/src/infrastructure/db/schema";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase } from "@/tests/helpers/test-database";

const limits = {
  maxBytes: 12 * 1024 * 1024,
  maxPixels: 40_000_000,
  longEdge: 2_048,
};

async function createPng(width = 12, height = 8): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 100, g: 160, b: 220, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

function createScanSession(unitOfWork: SessionUnitOfWork) {
  const fixtures = makeDomainFixtures();
  const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
  const preferences = savePreferences(unitOfWork, {
    sessionId: created.response.session.id,
    requestId: crypto.randomUUID(),
    expectedVersion: 0,
    preferences: fixtures.tasteProfile,
  });

  return { sessionId: created.response.session.id, version: preferences.response.session.version };
}

function createUploadDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "baijiu-upload-"));
}

const imageProcessor: ImageProcessor = {
  validate: validateImage,
  normalize: normalizeImage,
};

function uploadImage(
  unitOfWork: SessionUnitOfWork,
  store: Parameters<typeof uploadSessionImage>[1],
  input: Parameters<typeof uploadSessionImage>[2],
) {
  return uploadSessionImage(unitOfWork, store, input, imageProcessor);
}

describe("uploadSessionImage", () => {
  it("normalizes an overview image, stores metadata, and advances the session version", async () => {
    const database = createTestDatabase();
    const uploadDirectory = createUploadDirectory();
    const unitOfWork = createSessionUnitOfWork(database.db);
    const store = new LocalImageStore(uploadDirectory);

    try {
      const session = createScanSession(unitOfWork);
      const result = await uploadImage(unitOfWork, store, {
        sessionId: session.sessionId,
        requestId: crypto.randomUUID(),
        expectedVersion: session.version,
        role: "overview",
        filename: "../../x.png",
        declaredMime: "image/png",
        bytes: await createPng(),
        limits,
      });

      const savedImage = database.db.select().from(images).all();

      expect(result.replayed).toBe(false);
      expect(result.response.data.image).toMatchObject({
        role: "overview",
        mime: "image/jpeg",
        width: 12,
        height: 8,
      });
      expect(result.response.data.image).not.toHaveProperty("absolutePath");
      expect(result.response.session).toMatchObject({ state: "SCAN", version: 2 });
      expect(savedImage).toHaveLength(1);
      expect(savedImage[0].objectKey).toMatch(
        new RegExp(`^${session.sessionId}/overview-[0-9a-f-]{36}\\.jpg$`),
      );
      expect(readdirSync(path.join(uploadDirectory, session.sessionId))).toHaveLength(1);
    } finally {
      database.cleanup();
      rmSync(uploadDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a stale expectedVersion without writing a file or image record", async () => {
    const database = createTestDatabase();
    const uploadDirectory = createUploadDirectory();
    const unitOfWork = createSessionUnitOfWork(database.db);
    const store = new LocalImageStore(uploadDirectory);

    try {
      const session = createScanSession(unitOfWork);

      await expect(
        uploadImage(unitOfWork, store, {
          sessionId: session.sessionId,
          requestId: crypto.randomUUID(),
          expectedVersion: session.version - 1,
          role: "overview",
          filename: "valid.png",
          declaredMime: "image/png",
          bytes: await createPng(),
          limits,
        }),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

      expect(database.db.select().from(images).all()).toHaveLength(0);
      expect(readdirSync(uploadDirectory)).toHaveLength(0);
    } finally {
      database.cleanup();
      rmSync(uploadDirectory, { recursive: true, force: true });
    }
  });

  it("replays the same request without duplicate files or records and rejects a changed fingerprint", async () => {
    const database = createTestDatabase();
    const uploadDirectory = createUploadDirectory();
    const unitOfWork = createSessionUnitOfWork(database.db);
    const store = new LocalImageStore(uploadDirectory);
    const bytes = await createPng();

    try {
      const session = createScanSession(unitOfWork);
      const requestId = crypto.randomUUID();
      const input = {
        sessionId: session.sessionId,
        requestId,
        expectedVersion: session.version,
        role: "overview" as const,
        filename: "valid.png",
        declaredMime: "image/png",
        bytes,
        limits,
      };

      const first = await uploadImage(unitOfWork, store, input);
      const replay = await uploadImage(unitOfWork, store, input);

      expect(replay.replayed).toBe(true);
      expect(replay.response).toEqual(first.response);
      expect(database.db.select().from(images).all()).toHaveLength(1);
      expect(readdirSync(path.join(uploadDirectory, session.sessionId))).toHaveLength(1);

      await expect(
        uploadImage(unitOfWork, store, {
          ...input,
          bytes: await createPng(13, 8),
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    } finally {
      database.cleanup();
      rmSync(uploadDirectory, { recursive: true, force: true });
    }
  });

  it("deletes the newly written file when the database transaction fails", async () => {
    const database = createTestDatabase();
    const uploadDirectory = createUploadDirectory();
    const realUnitOfWork = createSessionUnitOfWork(database.db);
    const store = new LocalImageStore(uploadDirectory);
    const session = createScanSession(realUnitOfWork);
    const failingUnitOfWork: SessionUnitOfWork = {
      read: () => realUnitOfWork.read(),
      transaction: (operation) =>
        realUnitOfWork.transaction((repository) => {
          repository.saveIdempotencyRecord = () => {
            throw new Error("DB_WRITE_FAILED");
          };
          return operation(repository);
        }),
    };

    try {
      await expect(
        uploadImage(failingUnitOfWork, store, {
          sessionId: session.sessionId,
          requestId: crypto.randomUUID(),
          expectedVersion: session.version,
          role: "overview",
          filename: "valid.png",
          declaredMime: "image/png",
          bytes: await createPng(),
          limits,
        }),
      ).rejects.toThrow("DB_WRITE_FAILED");

      expect(database.db.select().from(images).all()).toHaveLength(0);
      expect(readdirSync(uploadDirectory)).toHaveLength(0);
    } finally {
      database.cleanup();
      rmSync(uploadDirectory, { recursive: true, force: true });
    }
  });

  it("cleans up the losing file when two handles race with the same requestId", async () => {
    const database = createTestDatabase();
    const secondDatabase = createDatabase(database.databasePath);
    const uploadDirectory = createUploadDirectory();
    const firstUnitOfWork = createSessionUnitOfWork(database.db);
    const secondUnitOfWork = createSessionUnitOfWork(secondDatabase.db);
    const store = new LocalImageStore(uploadDirectory);
    const session = createScanSession(firstUnitOfWork);
    const requestId = crypto.randomUUID();
    const commonInput = {
      sessionId: session.sessionId,
      requestId,
      expectedVersion: session.version,
      role: "overview" as const,
      filename: "valid.png",
      declaredMime: "image/png",
      bytes: await createPng(),
      limits,
    };

    try {
      const [first, second] = await Promise.all([
        uploadImage(firstUnitOfWork, store, commonInput),
        uploadImage(secondUnitOfWork, store, commonInput),
      ]);

      expect(first.response).toEqual(second.response);
      expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
      expect(database.db.select().from(images).all()).toHaveLength(1);
      expect(readdirSync(path.join(uploadDirectory, session.sessionId))).toHaveLength(1);
    } finally {
      secondDatabase.close();
      database.cleanup();
      rmSync(uploadDirectory, { recursive: true, force: true });
    }
  });
});
