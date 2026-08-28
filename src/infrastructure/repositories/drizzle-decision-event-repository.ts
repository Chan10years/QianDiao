import { randomUUID } from "node:crypto";

import { decisionEvents } from "@/src/infrastructure/db/schema";
import type { DatabaseExecutor } from "@/src/infrastructure/db/transaction";
import type {
  CreateDecisionEventInput,
  DecisionEventRepository,
} from "@/src/repositories/decision-event-repository";
import { z } from "zod";

const DecisionEventInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    type: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(1000),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

export class DrizzleDecisionEventRepository implements DecisionEventRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  createDecisionEvent(input: CreateDecisionEventInput): string {
    const parsed = DecisionEventInputSchema.parse(input);
    const id = randomUUID();

    this.database
      .insert(decisionEvents)
      .values({
        id,
        sessionId: parsed.sessionId,
        eventType: parsed.type,
        summary: parsed.summary,
        metadataJson: JSON.stringify(parsed.metadata),
      })
      .run();

    return id;
  }
}
