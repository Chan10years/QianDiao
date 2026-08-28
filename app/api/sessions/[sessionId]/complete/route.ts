import { z } from "zod";

import {
  completeSession,
  type CompleteSessionDependencies,
} from "@/src/application/complete-session";
import { createDefaultCompleteSessionDependencies } from "@/src/infrastructure/routes/recipe-route-dependencies";
import { mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface CompleteSessionRouteContext {
  params: Promise<{ sessionId: string }>;
}

export function createCompleteSessionRouteHandlers(
  dependencies: CompleteSessionDependencies = createDefaultCompleteSessionDependencies(),
) {
  return {
    async POST(request: Request, context: CompleteSessionRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const body = JsonObjectSchema.parse(await readJson(request));
        const result = completeSession(dependencies, { ...body, sessionId });
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

export async function POST(
  request: Request,
  context: CompleteSessionRouteContext,
): Promise<Response> {
  return createCompleteSessionRouteHandlers().POST(request, context);
}
