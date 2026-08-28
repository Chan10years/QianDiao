import type { ImageRole } from "@/src/providers/image-store";

export interface ImageRecord {
  id: string;
  sessionId: string;
  role: ImageRole;
  recipeId: string | null;
  stepIndex: number | null;
  objectKey: string;
  mime: string;
  width: number;
  height: number;
  createdAt: Date;
}

export interface CreateImageInput {
  id: string;
  sessionId: string;
  role: ImageRole;
  recipeId?: string | null;
  stepIndex?: number | null;
  objectKey: string;
  mime: string;
  width: number;
  height: number;
}

export interface UpdateImageInput {
  id: string;
  objectKey: string;
  mime: string;
  width: number;
  height: number;
}

export interface ImageRepository {
  createImage(input: CreateImageInput): ImageRecord;
  updateImage(input: UpdateImageInput): ImageRecord;
  findImageById(id: string): ImageRecord | null;
  findMixingStepImage(sessionId: string, recipeId: string, stepIndex: number): ImageRecord | null;
  listImagesBySession(sessionId: string): ImageRecord[];
}
