import { z } from "zod";

export const ImageRoleSchema = z.enum(["overview", "label_closeup", "final_drink", "mixing_step"]);
export type ImageRole = z.infer<typeof ImageRoleSchema>;

export interface ImageStoreSaveInput {
  sessionId: string;
  role: ImageRole;
  imageId: string;
  bytes: Uint8Array;
}

export interface StoredImageObject {
  objectKey: string;
}

export interface ImageStore {
  save(input: ImageStoreSaveInput): Promise<StoredImageObject>;
  delete(objectKey: string): Promise<void>;
}

export interface ImageReader {
  read(objectKey: string): Promise<Uint8Array>;
}
