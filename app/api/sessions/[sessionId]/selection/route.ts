import { z } from "zod";

import {
  selectRecipe,
  BlockedRecipeSelectionError,
  RecipeSafetyInvariantError,
  RecipeSelectionNotFoundError,
  WarningAcknowledgementRequiredError,
  type SelectRecipeDependencies,
} from "@/src/application/select-recipe";
import { createDefaultSelectRecipeDependencies } from "@/src/infrastructure/routes/recipe-route-dependencies";
import { errorResponse, mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface SelectionRouteContext {
  params: Promise<{ sessionId: string }>;
}

function mapSelectionError(error: unknown): Response {
  if (error instanceof WarningAcknowledgementRequiredError) {
    return errorResponse("INVALID_REQUEST", "WARN 方案必须先确认风险提示", 422);
  }
  if (error instanceof BlockedRecipeSelectionError) {
    return errorResponse("INVALID_REQUEST", "BLOCK 方案不能被选择", 422);
  }
  if (error instanceof RecipeSelectionNotFoundError) {
    return errorResponse("NOT_FOUND", "配方不存在或不属于当前会话", 404);
  }
  if (error instanceof RecipeSafetyInvariantError) {
    return errorResponse("INVALID_STATE", "当前配方的安全审计不一致，请重新生成", 409);
  }
  return mapSessionError(error);
}

export function createRecipeSelectionRouteHandlers(
  dependencies: SelectRecipeDependencies = createDefaultSelectRecipeDependencies(),
) {
  return {
    async PUT(request: Request, context: SelectionRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const body = JsonObjectSchema.parse(await readJson(request));
        const result = selectRecipe(dependencies, { ...body, sessionId });
        return Response.json(result.response, { status: 200 });
      } catch (error) {
        return mapSelectionError(error);
      }
    },
  };
}

export async function PUT(request: Request, context: SelectionRouteContext): Promise<Response> {
  return createRecipeSelectionRouteHandlers().PUT(request, context);
}
