import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { ImageValidationError, validateImage } from "@/src/infrastructure/uploads/validate-image";

const limits = {
  maxBytes: 12 * 1024 * 1024,
  maxPixels: 40_000_000,
};

async function createImage(
  format: "jpeg" | "png" | "webp",
  width = 4,
  height = 3,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 220, g: 120, b: 80, alpha: 1 },
    },
  })
    [format]()
    .toBuffer();
}

describe("validateImage", () => {
  it("accepts real JPEG, PNG, and WebP bytes", async () => {
    const cases = [
      { format: "jpeg" as const, filename: "valid.jpg", mime: "image/jpeg" },
      { format: "png" as const, filename: "valid.png", mime: "image/png" },
      { format: "webp" as const, filename: "valid.webp", mime: "image/webp" },
    ];

    for (const testCase of cases) {
      const bytes = await createImage(testCase.format);
      const result = await validateImage(
        {
          filename: testCase.filename,
          declaredMime: testCase.mime,
          bytes,
        },
        limits,
      );

      expect(result.mime).toBe(testCase.mime);
      expect(result.width).toBe(4);
      expect(result.height).toBe(3);
    }
  });

  it("accepts a PNG filename and declaration when the bytes are actually JPEG", async () => {
    const jpeg = await createImage("jpeg");

    const result = await validateImage(
      { filename: "tmp_img.png", declaredMime: "image/png", bytes: jpeg },
      limits,
    );

    expect(result.mime).toBe("image/jpeg");
  });

  it("accepts a JPG filename and declaration when the bytes are actually PNG", async () => {
    const png = await createImage("png");

    const result = await validateImage(
      { filename: "tmp_img.jpg", declaredMime: "image/jpeg", bytes: png },
      limits,
    );

    expect(result.mime).toBe("image/png");
  });

  it("rejects bytes that are not an image", async () => {
    await expect(
      validateImage(
        { filename: "not-an-image.png", declaredMime: "image/png", bytes: Buffer.from("not an image") },
        limits,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
    });
  });

  it("rejects bytes over the configured limit before decoding", async () => {
    const bytes = await createImage("jpeg");

    await expect(
      validateImage(
        { filename: "valid.jpg", declaredMime: "image/jpeg", bytes },
        { ...limits, maxBytes: bytes.length - 1 },
      ),
    ).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
      status: 413,
    });
  });

  it("rejects decoded images over the pixel limit", async () => {
    const bytes = await createImage("png", 100, 100);

    await expect(
      validateImage(
        { filename: "oversized-dimensions.png", declaredMime: "image/png", bytes },
        { ...limits, maxPixels: 9_999 },
      ),
    ).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
      status: 413,
    });
  });

  it("maps undecodable image bytes to a stable 422 error", async () => {
    const corruptJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const error = await validateImage(
      { filename: "corrupt.jpg", declaredMime: "image/jpeg", bytes: corruptJpeg },
      limits,
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ImageValidationError);
    expect(error).toMatchObject({ code: "INVALID_IMAGE", status: 422 });
  });

  it("returns an actionable compatibility error for HEIC", async () => {
    await expect(
      validateImage(
        { filename: "photo.heic", declaredMime: "image/heic", bytes: Buffer.from("heic") },
        limits,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
      message: expect.stringContaining("JPEG"),
    });
  });
});
