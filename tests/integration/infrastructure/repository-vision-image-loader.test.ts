import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RepositoryVisionImageLoader } from "@/src/infrastructure/providers/repository-vision-image-loader";
import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";
import type { ImageRecord } from "@/src/repositories/image-repository";

describe("RepositoryVisionImageLoader", () => {
  it("reads the normalized JPEG from controlled storage and creates a data URL", async () => {
    const uploadDirectory = mkdtempSync(path.join(tmpdir(), "vision-image-loader-test-"));
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const imageId = "22222222-2222-4222-8222-222222222222";
    const imageStore = new LocalImageStore(uploadDirectory);
    const stored = await imageStore.save({
      sessionId,
      role: "overview",
      imageId,
      bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    const image: ImageRecord = {
      id: imageId,
      sessionId,
      role: "overview",
      objectKey: stored.objectKey,
      mime: "image/jpeg",
      width: 1,
      height: 1,
      recipeId: null,
      stepIndex: null,
      createdAt: new Date(),
    };

    try {
      const loader = new RepositoryVisionImageLoader(
        { findImageById: (id) => (id === imageId ? image : null) },
        imageStore,
      );

      const [content] = await loader.load({ overviewImageId: imageId, labelImageIds: [] });

      expect(content).toEqual({
        imageId,
        mime: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,/9j/2Q==",
      });
      expect(content.dataUrl).not.toContain(uploadDirectory);
      expect(content.dataUrl).not.toContain(stored.objectKey);
    } finally {
      rmSync(uploadDirectory, { recursive: true, force: true });
    }
  });
});
