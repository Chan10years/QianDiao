export const DEFAULT_IMAGE_UPLOAD_BYTES = 12 * 1024 * 1024;
export const DEFAULT_IMAGE_PIXELS = 40_000_000;

export type SupportedImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface ImageProcessingInput {
  filename: string;
  declaredMime: string;
  bytes: Uint8Array;
}

export interface ImageValidationLimits {
  maxBytes: number;
  maxPixels: number;
}

export interface ValidatedImage {
  bytes: Uint8Array;
  mime: SupportedImageMime;
  width: number;
  height: number;
}

export interface ImageNormalizationOptions {
  longEdge: number;
}

export interface NormalizedImage {
  bytes: Uint8Array;
  mime: "image/jpeg";
  width: number;
  height: number;
}

export interface ImageProcessor {
  validate(input: ImageProcessingInput, limits: ImageValidationLimits): Promise<ValidatedImage>;
  normalize(bytes: Uint8Array, options: ImageNormalizationOptions): Promise<NormalizedImage>;
}
