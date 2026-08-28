import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { createSession } from "@/src/application/create-session";
import { savePreferences } from "@/src/application/save-preferences";
import { createSessionUnitOfWork } from "@/src/application/unit-of-work";
import { createImageRouteHandlers } from "@/app/api/sessions/[sessionId]/images/route";
import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase } from "@/tests/helpers/test-database";

const limits = {
  maxBytes: 12 * 1024 * 1024,
  maxPixels: 40_000_000,
  longEdge: 2_048,
};

async function createPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 5,
      height: 4,
      channels: 4,
      background: { r: 100, g: 160, b: 220, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

function toBlobBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function createScanSession(maxBytes = 12 * 1024 * 1024) {
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
  const uploadDirectory = mkdtempSync(path.join(tmpdir(), "baijiu-route-upload-"));
  const store = new LocalImageStore(uploadDirectory);
  const handlers = createImageRouteHandlers(unitOfWork, store, { ...limits, maxBytes });

  return {
    database,
    uploadDirectory,
    handlers,
    sessionId: created.response.session.id,
    version: preferences.response.session.version,
  };
}

function requestWithFile(
  sessionId: string,
  version: number,
  file: File | null,
  requestId = crypto.randomUUID(),
): Request {
  const form = new FormData();
  form.set("requestId", requestId);
  form.set("expectedVersion", String(version));
  form.set("role", "overview");
  if (file !== null) {
    form.set("file", file);
  }

  return new Request(`http://localhost/api/sessions/${sessionId}/images`, {
    method: "POST",
    body: form,
  });
}

describe("image upload route handlers", () => {
  it("returns 415 for a fake image whose declared MIME and extension do not match its bytes", async () => {
    const context = createScanSession();

    try {
      const response = await context.handlers.POST(
        requestWithFile(
          context.sessionId,
          context.version,
          new File([toBlobBytes(await createPng())], "fake.jpg", { type: "image/jpeg" }),
        ),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(response.status).toBe(415);
      expect((await response.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    } finally {
      context.database.cleanup();
      rmSync(context.uploadDirectory, { recursive: true, force: true });
    }
  });

  it("returns 413 when the decoded file exceeds the configured byte limit", async () => {
    const context = createScanSession(16);

    try {
      const response = await context.handlers.POST(
        requestWithFile(
          context.sessionId,
          context.version,
          new File([toBlobBytes(Buffer.alloc(32, 1))], "valid.png", { type: "image/png" }),
        ),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(response.status).toBe(413);
      expect((await response.json()).error.code).toBe("FILE_TOO_LARGE");
    } finally {
      context.database.cleanup();
      rmSync(context.uploadDirectory, { recursive: true, force: true });
    }
  });

  it("returns 422 for bytes with a valid image signature that sharp cannot decode", async () => {
    const context = createScanSession();

    try {
      const response = await context.handlers.POST(
        requestWithFile(
          context.sessionId,
          context.version,
          new File([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], "bad.jpg", {
            type: "image/jpeg",
          }),
        ),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe("INVALID_IMAGE");
    } finally {
      context.database.cleanup();
      rmSync(context.uploadDirectory, { recursive: true, force: true });
    }
  });

  it("returns 400 when multipart metadata or file is missing", async () => {
    const context = createScanSession();

    try {
      const response = await context.handlers.POST(
        requestWithFile(context.sessionId, context.version, null),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    } finally {
      context.database.cleanup();
      rmSync(context.uploadDirectory, { recursive: true, force: true });
    }
  });
});
