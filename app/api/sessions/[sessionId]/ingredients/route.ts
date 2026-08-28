import { z } from "zod";

import { confirmIngredients } from "@/src/application/confirm-ingredients";
import { getDefaultSessionUnitOfWork, type VisionUnitOfWork } from "@/src/application/unit-of-work";
import { mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface IngredientConfirmationRouteContext {
  params: Promise<{ sessionId: string }>;
}

export function createIngredientConfirmationRouteHandlers(unitOfWork: VisionUnitOfWork) {
  return {
    async PUT(request: Request, context: IngredientConfirmationRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const body = JsonObjectSchema.parse(await readJson(request));
        const result = await confirmIngredients(unitOfWork, { ...body, sessionId });

        return Response.json(result.response, { status: 200 });
      } catch (error) {
        return mapSessionError(error);
      }
    },
  };
}

export async function PUT(
  request: Request,
  context: IngredientConfirmationRouteContext,
): Promise<Response> {
  return createIngredientConfirmationRouteHandlers(getDefaultSessionUnitOfWork()).PUT(
    request,
    context,
  );
}
