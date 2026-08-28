import { z } from "zod";

import {
  acceptAdjustment,
  type AcceptAdjustmentDependencies,
} from "@/src/application/accept-adjustment";
import { createDefaultAcceptAdjustmentDependencies } from "@/src/infrastructure/routes/recipe-route-dependencies";
import { mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface AcceptAdjustmentRouteContext {
  params: Promise<{ sessionId: string }>;
}

export function createAcceptAdjustmentRouteHandlers(
  dependencies: AcceptAdjustmentDependencies = createDefaultAcceptAdjustmentDependencies(),
) {
  return {
    async POST(request: Request, context: AcceptAdjustmentRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const body = JsonObjectSchema.parse(await readJson(request));
        const result = acceptAdjustment(dependencies, { ...body, sessionId });
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
  context: AcceptAdjustmentRouteContext,
): Promise<Response> {
  return createAcceptAdjustmentRouteHandlers().POST(request, context);
}
