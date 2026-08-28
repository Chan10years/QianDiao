export interface CreateDecisionEventInput {
  sessionId: string;
  type: string;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface DecisionEventRepository {
  createDecisionEvent(input: CreateDecisionEventInput): string;
}
