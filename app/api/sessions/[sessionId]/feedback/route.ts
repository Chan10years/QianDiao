import { z } from "zod";

import { saveFeedback, type SaveFeedbackDependencies } from "@/src/application/save-feedback";
import { createDefaultSaveFeedbackDependencies } from "@/src/infrastructure/routes/recipe-route-dependencies";
import { mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface FeedbackRouteContext {
  params: Promise<{ sessionId: string }>;
}

export function createFeedbackRouteHandlers(
  dependencies: SaveFeedbackDependencies = createDefaultSaveFeedbackDependencies(),
) {
  return {
    async POST(request: Request, context: FeedbackRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const body = JsonObjectSchema.parse(await readJson(request));
        const result = await saveFeedback(dependencies, { ...body, sessionId });
        return Response.json(
          {
            data: result,
            session: {
              id: result.sessionId,
              state: result.state,
              version: result.sessionVersion,
            },
          },
          { status: 200 },
        );
      } catch (error) {
        return mapSessionError(error);
      }
    },
  };
}

export async function POST(request: Request, context: FeedbackRouteContext): Promise<Response> {
  return createFeedbackRouteHandlers().POST(request, context);
}
