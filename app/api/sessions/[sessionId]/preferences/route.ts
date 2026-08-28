import { z } from "zod";

import { savePreferences } from "@/src/application/save-preferences";
import type { SessionUnitOfWork } from "@/src/application/unit-of-work";
import { getDefaultSessionUnitOfWork } from "@/src/application/unit-of-work";
import { mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";
import type { SessionRouteContext } from "@/app/api/sessions/[sessionId]/route";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export function createPreferenceRouteHandlers(unitOfWork: SessionUnitOfWork) {
  return {
    async PUT(request: Request, context: SessionRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const body = JsonObjectSchema.parse(await readJson(request));
        const result = savePreferences(unitOfWork, { ...body, sessionId });

        return Response.json(result.response, { status: 200 });
      } catch (error) {
        return mapSessionError(error);
      }
    },
  };
}

export async function PUT(request: Request, context: SessionRouteContext): Promise<Response> {
  return createPreferenceRouteHandlers(getDefaultSessionUnitOfWork()).PUT(request, context);
}
