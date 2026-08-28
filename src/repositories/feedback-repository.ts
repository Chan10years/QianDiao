import type { Feedback, FeedbackDeltas } from "@/src/domain/feedback";

export interface CreateFeedbackInput {
  id: string;
  sessionId: string;
  recipeId: string;
  feedback: unknown;
}

export interface FeedbackRecord {
  id: string;
  sessionId: string;
  recipeId: string;
  rating: number;
  accepted: boolean;
  deltas: FeedbackDeltas;
  notes: string | null;
  finalImageId: string | null;
  createdAt: Date;
}

export interface FeedbackRepository {
  create(input: CreateFeedbackInput): FeedbackRecord;
  findById(id: string): FeedbackRecord | null;
  listByRecipe(recipeId: string): FeedbackRecord[];
}

export type FeedbackInput = Feedback;
