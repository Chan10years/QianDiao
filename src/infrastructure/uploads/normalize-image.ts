import sharp from "sharp";

export interface NormalizeImageOptions {
  longEdge: number;
}

export interface NormalizedImage {
  bytes: Buffer;
  mime: "image/jpeg";
  width: number;
  height: number;
}

export class ImageNormalizationError extends Error {
  readonly code = "INVALID_IMAGE" as const;
  readonly status = 422 as const;

  constructor() {
    super("图片无法标准化，请重新选择图片");
    this.name = "ImageNormalizationError";
  }
}

export async function normalizeImage(
  bytes: Uint8Array,
  options: NormalizeImageOptions,
): Promise<NormalizedImage> {
  try {
    const result = await sharp(bytes)
      .rotate()
      .resize({
        width: options.longEdge,
        height: options.longEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg()
      .toBuffer({ resolveWithObject: true });

    return {
      bytes: result.data,
      mime: "image/jpeg",
      width: result.info.width,
      height: result.info.height,
    };
  } catch {
    throw new ImageNormalizationError();
  }
}
