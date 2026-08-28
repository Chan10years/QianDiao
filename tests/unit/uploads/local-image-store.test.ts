import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";

describe("LocalImageStore", () => {
  it("writes and deletes only a server-generated relative object key", async () => {
    const uploadDirectory = mkdtempSync(path.join(tmpdir(), "baijiu-image-store-"));
    const sessionId = randomUUID();
    const imageId = randomUUID();
    const bytes = Buffer.from("normalized-jpeg");
    const store = new LocalImageStore(uploadDirectory);

    try {
      const saved = await store.save({
        sessionId,
        role: "overview",
        imageId,
        bytes,
      });

      expect(saved.objectKey).toBe(`${sessionId}/overview-${imageId}.jpg`);
      expect(saved.objectKey).not.toContain("..");
      expect(saved).not.toHaveProperty("absolutePath");
      expect(readFileSync(path.join(uploadDirectory, saved.objectKey))).toEqual(bytes);

      await store.delete(saved.objectKey);
      expect(readdirSync(uploadDirectory)).toHaveLength(0);
    } finally {
      rmSync(uploadDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an object key that attempts path traversal", async () => {
    const uploadDirectory = mkdtempSync(path.join(tmpdir(), "baijiu-image-store-"));
    const store = new LocalImageStore(uploadDirectory);

    try {
      await expect(store.delete("../../outside.jpg")).rejects.toMatchObject({
        code: "INVALID_OBJECT_KEY",
      });
    } finally {
      rmSync(uploadDirectory, { recursive: true, force: true });
    }
  });
});
