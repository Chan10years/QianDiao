import { and, asc, eq } from "drizzle-orm";

import { images } from "@/src/infrastructure/db/schema";
import type { DatabaseExecutor } from "@/src/infrastructure/db/transaction";
import { ImageRoleSchema } from "@/src/providers/image-store";
import type {
  CreateImageInput,
  ImageRecord,
  ImageRepository,
  UpdateImageInput,
} from "@/src/repositories/image-repository";

export class DrizzleImageUploadRepository implements ImageRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  createImage(input: CreateImageInput): ImageRecord {
    this.database
      .insert(images)
      .values({
        ...input,
        recipeId: input.recipeId ?? null,
        stepIndex: input.stepIndex ?? null,
      })
      .run();
    const created = this.findImageById(input.id);
    if (created === null) {
      throw new Error("IMAGE_CREATE_FAILED");
    }
    return created;
  }

  updateImage(input: UpdateImageInput): ImageRecord {
    this.database
      .update(images)
      .set({
        objectKey: input.objectKey,
        mime: input.mime,
        width: input.width,
        height: input.height,
      })
      .where(eq(images.id, input.id))
      .run();
    const updated = this.findImageById(input.id);
    if (updated === null) {
      throw new Error("IMAGE_UPDATE_FAILED");
    }
    return updated;
  }

  findImageById(id: string): ImageRecord | null {
    const row = this.database.select().from(images).where(eq(images.id, id)).get();
    if (row === undefined) return null;

    return {
      id: row.id,
      sessionId: row.sessionId,
      role: ImageRoleSchema.parse(row.role),
      recipeId: row.recipeId,
      stepIndex: row.stepIndex,
      objectKey: row.objectKey,
      mime: row.mime,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt,
    };
  }

  findMixingStepImage(sessionId: string, recipeId: string, stepIndex: number): ImageRecord | null {
    const row = this.database
      .select()
      .from(images)
      .where(
        and(
          eq(images.sessionId, sessionId),
          eq(images.role, "mixing_step"),
          eq(images.recipeId, recipeId),
          eq(images.stepIndex, stepIndex),
        ),
      )
      .get();
    return row === undefined ? null : this.toRecord(row);
  }

  listImagesBySession(sessionId: string): ImageRecord[] {
    return this.database
      .select()
      .from(images)
      .where(eq(images.sessionId, sessionId))
      .orderBy(asc(images.createdAt))
      .all()
      .map((row) => this.toRecord(row));
  }

  private toRecord(row: typeof images.$inferSelect): ImageRecord {
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: ImageRoleSchema.parse(row.role),
      recipeId: row.recipeId,
      stepIndex: row.stepIndex,
      objectKey: row.objectKey,
      mime: row.mime,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt,
    };
  }
}
