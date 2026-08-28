import { getSession } from "@/src/application/get-session";
import { getDefaultSessionUnitOfWork, type VisionUnitOfWork } from "@/src/application/unit-of-work";
import { mapSessionError } from "@/src/infrastructure/http/envelopes";

export interface SessionRouteContext {
  params: Promise<{ sessionId: string }>;
}

export function createSessionDetailRouteHandlers(unitOfWork: VisionUnitOfWork) {
  return {
    async GET(_request: Request, context: SessionRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const snapshot = getSession(unitOfWork, { sessionId });

        return Response.json({
          data: {
            preferences: snapshot.preferences,
            selectedRecipeId: snapshot.selectedRecipeId,
            currentStep: snapshot.currentStep,
            ingredients: snapshot.ingredients,
            mixingPhotos: snapshot.mixingPhotos,
          },
          session: {
            id: snapshot.id,
            state: snapshot.state,
            version: snapshot.version,
          },
        });
      } catch (error) {
        return mapSessionError(error);
      }
    },
  };
}

export async function GET(request: Request, context: SessionRouteContext): Promise<Response> {
  return createSessionDetailRouteHandlers(getDefaultSessionUnitOfWork()).GET(request, context);
}
