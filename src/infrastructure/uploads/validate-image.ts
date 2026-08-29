import sharp from "sharp";

export const DEFAULT_MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000;

export const supportedImageMimes = ["image/jpeg", "image/png", "image/webp"] as const;
export type SupportedImageMime = (typeof supportedImageMimes)[number];

export interface ImageValidationLimits {
  maxBytes: number;
  maxPixels: number;
}

export interface ImageValidationInput {
  filename: string;
  declaredMime: string;
  bytes: Uint8Array;
}

export interface ValidatedImage {
  bytes: Buffer;
  mime: SupportedImageMime;
  width: number;
  height: number;
}

export type ImageValidationCode = "FILE_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "INVALID_IMAGE";

export class ImageValidationError extends Error {
  constructor(
    readonly code: ImageValidationCode,
    readonly status: 413 | 415 | 422,
    message: string,
  ) {
    super(message);
    this.name = "ImageValidationError";
  }
}

function unsupported(message: string): ImageValidationError {
  return new ImageValidationError("UNSUPPORTED_MEDIA_TYPE", 415, message);
}

function detectMime(bytes: Buffer): SupportedImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length >= pngSignature.length && bytes.subarray(0, 8).equals(pngSignature)) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

export async function validateImage(
  input: ImageValidationInput,
  limits: ImageValidationLimits = {
    maxBytes: DEFAULT_MAX_UPLOAD_BYTES,
    maxPixels: DEFAULT_MAX_IMAGE_PIXELS,
  },
): Promise<ValidatedImage> {
  const bytes = Buffer.from(input.bytes);

  if (bytes.length > limits.maxBytes) {
    throw new ImageValidationError("FILE_TOO_LARGE", 413, "图片文件过大");
  }

  const declaredMime = input.declaredMime.trim().toLowerCase();

  if (declaredMime === "image/heic" || declaredMime === "image/heif") {
    throw unsupported("当前暂不支持 HEIC/HEIF，请改用 JPEG 或相机兼容模式");
  }

  const detectedMime = detectMime(bytes);
  if (detectedMime === null) {
    throw unsupported("仅支持 JPEG、PNG 或 WebP 图片");
  }

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    throw new ImageValidationError("INVALID_IMAGE", 422, "图片无法解码，请重新选择图片");
  }

  const width = metadata.width;
  const height = metadata.height;
  if (
    width === undefined ||
    height === undefined ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new ImageValidationError("INVALID_IMAGE", 422, "图片缺少有效尺寸");
  }

  if (width * height > limits.maxPixels) {
    throw new ImageValidationError("FILE_TOO_LARGE", 413, "图片像素总量过大");
  }

  return { bytes, mime: detectedMime, width, height };
}
