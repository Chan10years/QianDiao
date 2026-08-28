import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { FeedbackDeltasSchema, FeedbackSchema } from "@/src/domain/feedback";
import type { DatabaseExecutor } from "@/src/infrastructure/db/transaction";
import { feedback } from "@/src/infrastructure/db/schema";
import type {
  CreateFeedbackInput,
  FeedbackRecord,
  FeedbackRepository,
} from "@/src/repositories/feedback-repository";

const IdSchema = z.string().uuid();

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function toFeedbackRecord(row: typeof feedback.$inferSelect): FeedbackRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    recipeId: row.recipeId,
    rating: row.rating,
    accepted: row.accepted,
    deltas: FeedbackDeltasSchema.parse(parseJson(row.deltasJson)),
    notes: row.notes,
    finalImageId: row.finalImageId,
    createdAt: row.createdAt,
  };
}

export class DrizzleFeedbackRepository implements FeedbackRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  create(input: CreateFeedbackInput): FeedbackRecord {
    const id = IdSchema.parse(input.id);
    const feedbackInput = FeedbackSchema.parse(input.feedback);
    this.database
      .insert(feedback)
      .values({
        id,
        sessionId: input.sessionId,
        recipeId: input.recipeId,
        rating: feedbackInput.rating,
        accepted: feedbackInput.accepted,
        deltasJson: JSON.stringify(FeedbackDeltasSchema.parse(feedbackInput.deltas)),
        notes: feedbackInput.notes ?? null,
        finalImageId: feedbackInput.finalImageId ?? null,
      })
      .run();

    const row = this.database.select().from(feedback).where(eq(feedback.id, id)).get();
    if (row === undefined) {
      throw new Error("FEEDBACK_CREATE_FAILED");
    }
    return toFeedbackRecord(row);
  }

  findById(id: string): FeedbackRecord | null {
    const row = this.database.select().from(feedback).where(eq(feedback.id, id)).get();
    return row === undefined ? null : toFeedbackRecord(row);
  }

  listByRecipe(recipeId: string): FeedbackRecord[] {
    return this.database
      .select()
      .from(feedback)
      .where(eq(feedback.recipeId, recipeId))
      .orderBy(asc(feedback.createdAt))
      .all()
      .map(toFeedbackRecord);
  }
}
