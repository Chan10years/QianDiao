import { z } from "zod";

import { SuccessEnvelopeSchema } from "@/src/domain/api";
import { DetectedIngredientSchema, type DetectedIngredient } from "@/src/domain/ingredient";
import {
  RecipeCandidateSchema,
  RecipeDisplaySchema,
  type RecipeCandidate,
  type RecipeDisplay,
} from "@/src/domain/recipe";
import { ImageRoleSchema } from "@/src/providers/image-store";
import { VisionResultSchema, type VisionResult } from "@/src/providers/vision-provider";
import { TasteProfileSchema, type TasteProfile } from "@/src/domain/preferences";
import {
  MixingActionSchema,
  SessionStateSchema,
  type MixingAction,
  type SessionState,
} from "@/src/domain/session";
import {
  RecipeProvenanceSchema,
  RecipeSourceModeSchema,
  type RecipeProvenance,
  type RecipeSourceMode,
} from "@/src/providers/recipe-provider";

const SessionSnapshotSchema = SuccessEnvelopeSchema(
  z
    .object({
      preferences: TasteProfileSchema.nullable(),
      selectedRecipeId: z.string().uuid().nullable(),
      currentStep: z.number().int().nonnegative().nullable(),
      ingredients: z.array(DetectedIngredientSchema).max(50),
      mixingPhotos: z
        .array(
          z
            .object({
              imageId: z.string().uuid(),
              role: z.literal("mixing_step"),
              recipeId: z.string().uuid(),
              stepIndex: z.number().int().nonnegative(),
              mime: z.literal("image/jpeg"),
              width: z.number().int().positive(),
              height: z.number().int().positive(),
            })
            .strict(),
        )
        .default([]),
    })
    .strict(),
);

const SavePreferencesResponseSchema = SuccessEnvelopeSchema(
  z.object({ preferences: TasteProfileSchema }).strict(),
);

const UploadOverviewImageResponseSchema = SuccessEnvelopeSchema(
  z
    .object({
      image: z
        .object({
          id: z.string().uuid(),
          role: z.literal("overview"),
          mime: z.literal("image/jpeg"),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
);

const UploadMixingStepImageResponseSchema = SuccessEnvelopeSchema(
  z
    .object({
      image: z
        .object({
          id: z.string().uuid(),
          role: z.literal("mixing_step"),
          mime: z.literal("image/jpeg"),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
);

const RecognitionResponseSchema = SuccessEnvelopeSchema(
  z.object({ recognition: VisionResultSchema }).strict(),
);

const ConfirmIngredientsResponseSchema = SuccessEnvelopeSchema(
  z.object({ ingredients: z.array(DetectedIngredientSchema).min(1).max(50) }).strict(),
);

const RecipeSetMetadataSchema = z
  .object({
    id: z.string().uuid(),
    sourceMode: RecipeSourceModeSchema,
    degraded: z.boolean(),
    provenance: RecipeProvenanceSchema,
    recommendedRecipeId: z.string().uuid(),
  })
  .strict();

const RecipeSetSnapshotResponseSchema = SuccessEnvelopeSchema(
  z
    .object({
      recipeSet: RecipeSetMetadataSchema.extend({
        recipes: z.array(RecipeDisplaySchema).length(3),
      }),
    })
    .strict(),
);

const GenerateRecipeSetResponseSchema = SuccessEnvelopeSchema(
  z
    .object({
      recipeSet: RecipeSetMetadataSchema.extend({
        recipes: z.array(RecipeCandidateSchema).length(3),
      }),
    })
    .strict(),
);

const SelectRecipeResponseSchema = SuccessEnvelopeSchema(
  z
    .object({
      recipeId: z.string().uuid(),
      currentStep: z.literal(0),
      totalSteps: z.number().int().positive(),
      warningAcknowledged: z.boolean(),
    })
    .strict(),
);

const AdvanceMixingResponseSchema = SuccessEnvelopeSchema(
  z
    .object({
      action: MixingActionSchema,
      currentStep: z.number().int().nonnegative().nullable(),
      totalSteps: z.number().int().positive(),
    })
    .strict(),
);

const ClientErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean(),
        fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
      })
      .strict(),
  })
  .strict();

export interface SessionSnapshot {
  data: {
    preferences: TasteProfile | null;
    selectedRecipeId: string | null;
    currentStep: number | null;
    ingredients: readonly DetectedIngredient[];
    mixingPhotos: readonly {
      imageId: string;
      role: "mixing_step";
      recipeId: string;
      stepIndex: number;
      mime: "image/jpeg";
      width: number;
      height: number;
    }[];
  };
  session: {
    id: string;
    state: SessionState;
    version: number;
  };
}

export interface SessionEnvelope {
  id: string;
  state: SessionState;
  version: number;
}

export interface SavePreferencesInput {
  sessionId: string;
  expectedVersion: number;
  preferences: TasteProfile;
}

export interface UploadOverviewImageInput {
  sessionId: string;
  expectedVersion: number;
  file: File;
}

export interface UploadOverviewImageResult {
  image: {
    id: string;
    role: "overview";
    mime: "image/jpeg";
    width: number;
    height: number;
  };
  session: SessionEnvelope;
}

export interface UploadMixingStepImageInput {
  sessionId: string;
  expectedVersion: number;
  recipeId: string;
  stepIndex: number;
  file: File;
}

export interface UploadMixingStepImageResult {
  image: {
    id: string;
    role: "mixing_step";
    mime: "image/jpeg";
    width: number;
    height: number;
  };
  session: SessionEnvelope;
}

export interface RecognizeIngredientsInput {
  sessionId: string;
  expectedVersion: number;
  overviewImageId: string;
  labelImageIds?: readonly string[];
}

export interface RecognitionResult {
  recognition: VisionResult;
  session: SessionEnvelope;
}

export interface ConfirmIngredientsInput {
  sessionId: string;
  expectedVersion: number;
  ingredients: readonly DetectedIngredient[];
}

export interface ConfirmIngredientsResult {
  ingredients: readonly DetectedIngredient[];
  session: SessionEnvelope;
}

export interface RecipeSetSnapshot {
  recipeSet: {
    id: string;
    sourceMode: RecipeSourceMode;
    degraded: boolean;
    provenance: RecipeProvenance;
    recommendedRecipeId: string;
    recipes: readonly RecipeDisplay[];
  };
  session: SessionEnvelope;
}

export interface GenerateRecipeSetInput {
  sessionId: string;
  expectedVersion: number;
}

export interface GenerateRecipeSetResult {
  recipeSet: {
    id: string;
    sourceMode: RecipeSourceMode;
    degraded: boolean;
    provenance: RecipeProvenance;
    recommendedRecipeId: string;
    recipes: readonly RecipeCandidate[];
  };
  session: SessionEnvelope;
}

export interface SelectRecipeInput {
  sessionId: string;
  expectedVersion: number;
  recipeId: string;
  warningAcknowledged: boolean;
}

export interface SelectRecipeResult {
  recipeId: string;
  currentStep: 0;
  totalSteps: number;
  warningAcknowledged: boolean;
  session: SessionEnvelope;
}

export interface AdvanceMixingInput {
  sessionId: string;
  expectedVersion: number;
  action: MixingAction;
}

export interface AdvanceMixingResult {
  action: MixingAction;
  currentStep: number | null;
  totalSteps: number;
  session: SessionEnvelope;
}

export interface SessionClientOptions {
  fetcher?: typeof fetch;
  requestIdFactory?: () => string;
}

export function sessionImageUrl(
  sessionId: string,
  imageId: string,
  committedVersion: number,
): string {
  return `/api/sessions/${sessionId}/images/${imageId}?v=${committedVersion}`;
}

export interface SessionClientLike {
  getSession(sessionId: string): Promise<SessionSnapshot>;
  getRecipeSet(sessionId: string): Promise<RecipeSetSnapshot>;
  savePreferences(input: SavePreferencesInput): Promise<SessionSnapshot>;
  uploadOverviewImage(input: UploadOverviewImageInput): Promise<UploadOverviewImageResult>;
  uploadMixingStepImage(input: UploadMixingStepImageInput): Promise<UploadMixingStepImageResult>;
  recognizeIngredients(input: RecognizeIngredientsInput): Promise<RecognitionResult>;
  confirmIngredients(input: ConfirmIngredientsInput): Promise<ConfirmIngredientsResult>;
  generateRecipeSet(input: GenerateRecipeSetInput): Promise<GenerateRecipeSetResult>;
  selectRecipe(input: SelectRecipeInput): Promise<SelectRecipeResult>;
  advanceMixing(input: AdvanceMixingInput): Promise<AdvanceMixingResult>;
}

export class SessionClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = "SessionClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

type MutationName =
  | "save-preferences"
  | "upload-overview-image"
  | "upload-mixing-step-image"
  | "recognize-ingredients"
  | "confirm-ingredients"
  | "generate-recipe-set"
  | "select-recipe"
  | "advance-mixing";

export class SessionClient {
  private readonly fetcher: typeof fetch;
  private readonly requestIdFactory: () => string;
  private readonly pendingRequestIds = new Map<MutationName, string>();

  constructor(options: SessionClientOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.requestIdFactory = options.requestIdFactory ?? (() => crypto.randomUUID());
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    const response = await this.fetcher(`/api/sessions/${sessionId}`, {
      method: "GET",
      cache: "no-store",
    });
    return parseResponse(response, SessionSnapshotSchema);
  }

  async getRecipeSet(sessionId: string): Promise<RecipeSetSnapshot> {
    const response = await this.fetcher(`/api/sessions/${sessionId}/recipes`, {
      method: "GET",
      cache: "no-store",
    });
    const parsed = await parseResponse(response, RecipeSetSnapshotResponseSchema);
    return {
      recipeSet: parsed.data.recipeSet,
      session: parseSessionEnvelope(parsed.session),
    };
  }

  async savePreferences(input: SavePreferencesInput): Promise<SessionSnapshot> {
    const requestId = this.requestIdFor("save-preferences");
    const response = await this.fetcher(`/api/sessions/${input.sessionId}/preferences`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        expectedVersion: input.expectedVersion,
        preferences: TasteProfileSchema.parse(input.preferences),
      }),
    });
    const parsed = await this.parseMutationResponse(
      "save-preferences",
      response,
      SavePreferencesResponseSchema,
    );
    this.pendingRequestIds.delete("save-preferences");

    return {
      data: {
        preferences: parsed.data.preferences,
        selectedRecipeId: null,
        currentStep: null,
        ingredients: [],
        mixingPhotos: [],
      },
      session: {
        id: parsed.session.id,
        state: SessionStateSchema.parse(parsed.session.state),
        version: parsed.session.version,
      },
    };
  }

  async uploadOverviewImage(input: UploadOverviewImageInput): Promise<UploadOverviewImageResult> {
    const requestId = this.requestIdFor("upload-overview-image");
    const form = new FormData();
    form.set("requestId", requestId);
    form.set("expectedVersion", String(input.expectedVersion));
    form.set("role", ImageRoleSchema.parse("overview"));
    form.set("file", input.file, input.file.name);

    const response = await this.fetcher(`/api/sessions/${input.sessionId}/images`, {
      method: "POST",
      body: form,
    });
    const parsed = await this.parseMutationResponse(
      "upload-overview-image",
      response,
      UploadOverviewImageResponseSchema,
    );
    this.pendingRequestIds.delete("upload-overview-image");

    return {
      image: parsed.data.image,
      session: parseSessionEnvelope(parsed.session),
    };
  }

  async uploadMixingStepImage(
    input: UploadMixingStepImageInput,
  ): Promise<UploadMixingStepImageResult> {
    const requestId = this.requestIdFor("upload-mixing-step-image");
    const form = new FormData();
    form.set("requestId", requestId);
    form.set("expectedVersion", String(input.expectedVersion));
    form.set("role", ImageRoleSchema.parse("mixing_step"));
    form.set("recipeId", input.recipeId);
    form.set("stepIndex", String(input.stepIndex));
    form.set("file", input.file, input.file.name);

    const response = await this.fetcher(`/api/sessions/${input.sessionId}/images`, {
      method: "POST",
      body: form,
    });
    const parsed = await this.parseMutationResponse(
      "upload-mixing-step-image",
      response,
      UploadMixingStepImageResponseSchema,
    );
    this.pendingRequestIds.delete("upload-mixing-step-image");

    return {
      image: parsed.data.image,
      session: parseSessionEnvelope(parsed.session),
    };
  }

  async recognizeIngredients(input: RecognizeIngredientsInput): Promise<RecognitionResult> {
    const requestId = this.requestIdFor("recognize-ingredients");
    const response = await this.fetcher(`/api/sessions/${input.sessionId}/recognition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        expectedVersion: input.expectedVersion,
        overviewImageId: input.overviewImageId,
        labelImageIds: [...(input.labelImageIds ?? [])],
      }),
    });
    const parsed = await this.parseMutationResponse(
      "recognize-ingredients",
      response,
      RecognitionResponseSchema,
    );
    this.pendingRequestIds.delete("recognize-ingredients");

    return {
      recognition: parsed.data.recognition,
      session: parseSessionEnvelope(parsed.session),
    };
  }

  async confirmIngredients(input: ConfirmIngredientsInput): Promise<ConfirmIngredientsResult> {
    const requestId = this.requestIdFor("confirm-ingredients");
    const response = await this.fetcher(`/api/sessions/${input.sessionId}/ingredients`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        expectedVersion: input.expectedVersion,
        ingredients: z.array(DetectedIngredientSchema).min(1).max(50).parse(input.ingredients),
      }),
    });
    const parsed = await this.parseMutationResponse(
      "confirm-ingredients",
      response,
      ConfirmIngredientsResponseSchema,
    );
    this.pendingRequestIds.delete("confirm-ingredients");

    return {
      ingredients: parsed.data.ingredients,
      session: parseSessionEnvelope(parsed.session),
    };
  }

  async generateRecipeSet(input: GenerateRecipeSetInput): Promise<GenerateRecipeSetResult> {
    const requestId = this.requestIdFor("generate-recipe-set");
    const response = await this.fetcher(`/api/sessions/${input.sessionId}/recipes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        expectedVersion: input.expectedVersion,
      }),
    });
    const parsed = await this.parseMutationResponse(
      "generate-recipe-set",
      response,
      GenerateRecipeSetResponseSchema,
    );
    this.pendingRequestIds.delete("generate-recipe-set");
    return {
      recipeSet: parsed.data.recipeSet,
      session: parseSessionEnvelope(parsed.session),
    };
  }

  async selectRecipe(input: SelectRecipeInput): Promise<SelectRecipeResult> {
    const requestId = this.requestIdFor("select-recipe");
    const response = await this.fetcher(`/api/sessions/${input.sessionId}/selection`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        expectedVersion: input.expectedVersion,
        recipeId: input.recipeId,
        warningAcknowledged: input.warningAcknowledged,
      }),
    });
    const parsed = await this.parseMutationResponse(
      "select-recipe",
      response,
      SelectRecipeResponseSchema,
    );
    this.pendingRequestIds.delete("select-recipe");
    return {
      ...parsed.data,
      session: parseSessionEnvelope(parsed.session),
    };
  }

  async advanceMixing(input: AdvanceMixingInput): Promise<AdvanceMixingResult> {
    const requestId = this.requestIdFor("advance-mixing");
    const response = await this.fetcher(`/api/sessions/${input.sessionId}/mixing/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        expectedVersion: input.expectedVersion,
        action: MixingActionSchema.parse(input.action),
      }),
    });
    const parsed = await this.parseMutationResponse(
      "advance-mixing",
      response,
      AdvanceMixingResponseSchema,
    );
    this.pendingRequestIds.delete("advance-mixing");
    return {
      ...parsed.data,
      session: parseSessionEnvelope(parsed.session),
    };
  }

  private requestIdFor(operation: MutationName): string {
    const existing = this.pendingRequestIds.get(operation);
    if (existing !== undefined) return existing;

    const next = this.requestIdFactory();
    this.pendingRequestIds.set(operation, next);
    return next;
  }

  private async parseMutationResponse<T extends z.ZodType>(
    operation: MutationName,
    response: Response,
    schema: T,
  ): Promise<z.infer<T>> {
    try {
      return await parseResponse(response, schema);
    } catch (error) {
      if (error instanceof SessionClientError && error.code === "VERSION_CONFLICT") {
        this.pendingRequestIds.delete(operation);
      }
      throw error;
    }
  }
}

async function parseResponse<T extends z.ZodType>(
  response: Response,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SessionClientError("INVALID_RESPONSE", "服务器响应无效，请重试", true);
  }

  if (!response.ok) {
    const parsedError = ClientErrorEnvelopeSchema.safeParse(body);
    if (parsedError.success) {
      throw new SessionClientError(
        parsedError.data.error.code,
        parsedError.data.error.message,
        parsedError.data.error.retryable,
      );
    }
    throw new SessionClientError("INVALID_RESPONSE", "服务器响应无效，请重试", true);
  }

  try {
    return schema.parse(body);
  } catch (error) {
    throw new SessionClientError("INVALID_RESPONSE", "服务器响应无效，请重试", true, error);
  }
}

function parseSessionEnvelope(input: {
  id: string;
  state: string;
  version: number;
}): SessionEnvelope {
  return {
    id: input.id,
    state: SessionStateSchema.parse(input.state),
    version: input.version,
  };
}
