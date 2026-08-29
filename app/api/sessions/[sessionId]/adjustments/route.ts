import { z } from "zod";

import {
  generateAdjustment,
  type GenerateAdjustmentDependencies,
} from "@/src/application/generate-adjustment";
import {
  getAdjustmentState,
  type GetAdjustmentStateDependencies,
} from "@/src/application/get-adjustment-state";
import { createDefaultGenerateAdjustmentDependencies } from "@/src/infrastructure/routes/recipe-route-dependencies";
import { mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface AdjustmentRouteContext {
  params: Promise<{ sessionId: string }>;
}

export function createAdjustmentRouteHandlers(
  dependencies: GenerateAdjustmentDependencies = createDefaultGenerateAdjustmentDependencies(),
  adjustmentStateDependencies: GetAdjustmentStateDependencies = {
    read: () => dependencies.read(),
  },
) {
  return {
    async POST(request: Request, context: AdjustmentRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const body = JsonObjectSchema.parse(await readJson(request));
        const result = await generateAdjustment(dependencies, { ...body, sessionId });
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

    async GET(_request: Request, context: AdjustmentRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const result = getAdjustmentState(adjustmentStateDependencies, { sessionId });
        return Response.json(
          {
            data: result.data,
            session: result.session,
          },
          { status: 200 },
        );
      } catch (error) {
        return mapSessionError(error);
      }
    },
  };
}

export async function POST(request: Request, context: AdjustmentRouteContext): Promise<Response> {
  return createAdjustmentRouteHandlers().POST(request, context);
}

export async function GET(_request: Request, context: AdjustmentRouteContext): Promise<Response> {
  return createAdjustmentRouteHandlers().GET(_request, context);
}
