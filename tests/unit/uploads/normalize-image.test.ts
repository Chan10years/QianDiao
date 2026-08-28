import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { normalizeImage } from "@/src/infrastructure/uploads/normalize-image";

describe("normalizeImage", () => {
  it("rotates by EXIF orientation, removes metadata, bounds the long edge, and emits JPEG", async () => {
    const source = await sharp({
      create: {
        width: 4_000,
        height: 2_000,
        channels: 3,
        background: { r: 40, g: 100, b: 180 },
      },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const normalized = await normalizeImage(source, { longEdge: 2_048 });
    const metadata = await sharp(normalized.bytes).metadata();

    expect(normalized.mime).toBe("image/jpeg");
    expect(normalized.width).toBe(1_024);
    expect(normalized.height).toBe(2_048);
    expect(metadata.format).toBe("jpeg");
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.comments).toBeUndefined();
  });

  it("does not upscale a small image while standardizing the format", async () => {
    const source = await sharp({
      create: {
        width: 8,
        height: 5,
        channels: 3,
        background: { r: 80, g: 80, b: 80 },
      },
    })
      .png()
      .toBuffer();

    const normalized = await normalizeImage(source, { longEdge: 2_048 });

    expect(normalized.width).toBe(8);
    expect(normalized.height).toBe(5);
    expect(normalized.mime).toBe("image/jpeg");
  });
});
