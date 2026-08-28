import { z } from "zod";

import { advanceMixing, type AdvanceMixingDependencies } from "@/src/application/advance-mixing";
import { createDefaultAdvanceMixingDependencies } from "@/src/infrastructure/routes/recipe-route-dependencies";
import { mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface MixingAdvanceRouteContext {
  params: Promise<{ sessionId: string }>;
}

export function createMixingAdvanceRouteHandlers(
  dependencies: AdvanceMixingDependencies = createDefaultAdvanceMixingDependencies(),
) {
  return {
    async POST(request: Request, context: MixingAdvanceRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const body = JsonObjectSchema.parse(await readJson(request));
        const result = advanceMixing(dependencies, { ...body, sessionId });
        return Response.json(result.response, { status: 200 });
      } catch (error) {
        return mapSessionError(error);
      }
    },
  };
}

export async function POST(
  request: Request,
  context: MixingAdvanceRouteContext,
): Promise<Response> {
  return createMixingAdvanceRouteHandlers().POST(request, context);
}
