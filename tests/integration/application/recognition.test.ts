import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { confirmIngredients } from "@/src/application/confirm-ingredients";
import { recognizeIngredients } from "@/src/application/recognize-ingredients";
import { createIngredientConfirmationRouteHandlers } from "@/app/api/sessions/[sessionId]/ingredients/route";
import { createRecognitionRouteHandlers } from "@/app/api/sessions/[sessionId]/recognition/route";
import { createSession } from "@/src/application/create-session";
import { savePreferences } from "@/src/application/save-preferences";
import { createSessionUnitOfWork, type VisionUnitOfWork } from "@/src/application/unit-of-work";
import {
  ingredients,
  decisionEvents,
  idempotencyRecords,
  images,
  sessions,
} from "@/src/infrastructure/db/schema";
import type { VisionProvider, VisionResult } from "@/src/providers/vision-provider";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase } from "@/tests/helpers/test-database";

const visionResult: VisionResult = {
  ingredients: [
    {
      rawName: "二锅头",
      canonicalName: "白酒",
      category: "spirit",
      brand: null,
      abv: null,
      confidence: 0.72,
      confirmed: false,
    },
    {
      rawName: "苏打水",
      canonicalName: "苏打水",
      category: "mixer",
      brand: null,
      abv: null,
      confidence: 0.9,
      confirmed: false,
    },
  ],
  needsLabelCloseup: true,
  userQuestions: ["请确认酒精度（ABV）。"],
  sourceMode: "fallback",
};

class RecordingVisionProvider implements VisionProvider {
  calls = 0;

  constructor(
    private readonly result: VisionResult = visionResult,
    private readonly failure: Error | null = null,
  ) {}

  async recognize(): Promise<VisionResult> {
    this.calls += 1;
    if (this.failure !== null) {
      throw this.failure;
    }
    return this.result;
  }
}

class BlockingVisionProvider implements VisionProvider {
  calls = 0;
  private releaseFirstCall: (() => void) | null = null;
  private readonly firstCallReleased = new Promise<void>((resolve) => {
    this.releaseFirstCall = resolve;
  });

  async recognize(): Promise<VisionResult> {
    this.calls += 1;
    if (this.calls === 1) {
      await this.firstCallReleased;
    }
    return visionResult;
  }

  release(): void {
    this.releaseFirstCall?.();
  }
}

function jsonRequest(body: unknown, method: "POST" | "PUT" = "POST"): Request {
  return new Request("http://localhost/api/sessions/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createScanContext() {
  const database = createTestDatabase();
  const unitOfWork = createSessionUnitOfWork(database.db);
  const fixtures = makeDomainFixtures();
  const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
  const preferences = savePreferences(unitOfWork, {
    sessionId: created.response.session.id,
    requestId: crypto.randomUUID(),
    expectedVersion: 0,
    preferences: fixtures.tasteProfile,
  });
  const overviewImageId = crypto.randomUUID();

  database.db
    .insert(images)
    .values({
      id: overviewImageId,
      sessionId: created.response.session.id,
      role: "overview",
      objectKey: `${created.response.session.id}/overview-${overviewImageId}.jpg`,
      mime: "image/jpeg",
      width: 100,
      height: 80,
    })
    .run();

  return {
    database,
    unitOfWork: unitOfWork as VisionUnitOfWork,
    sessionId: created.response.session.id,
    expectedVersion: preferences.response.session.version,
    overviewImageId,
  };
}

function recognitionInput(context: ReturnType<typeof createScanContext>) {
  return {
    sessionId: context.sessionId,
    requestId: crypto.randomUUID(),
    expectedVersion: context.expectedVersion,
    overviewImageId: context.overviewImageId,
    labelImageIds: [],
  };
}

const confirmedIngredients = [
  {
    rawName: "修正后的高粱酒",
    canonicalName: "白酒",
    category: "spirit" as const,
    brand: "示例品牌",
    abv: 52,
    confidence: 1,
    confirmed: true,
  },
  {
    rawName: "新加入的薄荷",
    canonicalName: "薄荷",
    category: "herb" as const,
    brand: null,
    abv: null,
    confidence: 1,
    confirmed: true,
  },
];

async function confirmAfterRecognition(
  context: ReturnType<typeof createScanContext>,
  provider: RecordingVisionProvider,
  ingredientPayload: unknown,
) {
  await recognizeIngredients(context.unitOfWork, provider, recognitionInput(context));
  return confirmIngredients(context.unitOfWork, {
    sessionId: context.sessionId,
    requestId: crypto.randomUUID(),
    expectedVersion: 2,
    ingredients: ingredientPayload,
  });
}

describe("recognizeIngredients application", () => {
  it("persists normalized recognition, advances SCAN to CONFIRM, and records a summary event", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      const result = await recognizeIngredients(
        context.unitOfWork,
        provider,
        recognitionInput(context),
      );

      expect(result.replayed).toBe(false);
      expect(result.response.data.recognition).toMatchObject({
        ingredients: visionResult.ingredients,
        needsLabelCloseup: true,
        sourceMode: "fallback",
      });
      expect(result.response.data.recognition.userQuestions).toEqual(
        expect.arrayContaining(visionResult.userQuestions),
      );
      expect(result.response.session).toMatchObject({ state: "CONFIRM", version: 2 });
      expect(context.database.db.select().from(ingredients).all()).toHaveLength(2);
      expect(context.database.db.select().from(decisionEvents).all()).toMatchObject([
        { eventType: "ingredients_recognized" },
      ]);
    } finally {
      context.database.cleanup();
    }
  });

  it("keeps the uploaded image and SCAN session unchanged when the provider fails", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider(visionResult, new Error("provider offline"));

    try {
      await expect(
        recognizeIngredients(context.unitOfWork, provider, recognitionInput(context)),
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });

      expect(provider.calls).toBe(1);
      expect(context.database.db.select().from(images).all()).toHaveLength(1);
      expect(context.database.db.select().from(ingredients).all()).toHaveLength(0);
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "SCAN",
        version: 1,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("replays recognition by requestId without calling the provider or advancing twice", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();
    const input = recognitionInput(context);

    try {
      const first = await recognizeIngredients(context.unitOfWork, provider, input);
      const replay = await recognizeIngredients(context.unitOfWork, provider, input);

      expect(replay.replayed).toBe(true);
      expect(replay.response).toEqual(first.response);
      expect(provider.calls).toBe(1);
      expect(context.database.db.select().from(sessions).all()[0]?.version).toBe(2);
    } finally {
      context.database.cleanup();
    }
  });

  it("returns 409 for a reused requestId with a different body without writing again", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();
    const requestId = crypto.randomUUID();
    const route = createRecognitionRouteHandlers(context.unitOfWork, provider);
    const routeContext = { params: Promise.resolve({ sessionId: context.sessionId }) };
    const firstBody = {
      requestId,
      expectedVersion: context.expectedVersion,
      overviewImageId: context.overviewImageId,
      labelImageIds: [],
    };

    try {
      const firstResponse = await route.POST(jsonRequest(firstBody), routeContext);
      expect(firstResponse.status).toBe(200);

      const beforeRetry = {
        ingredientCount: context.database.db.select().from(ingredients).all().length,
        decisionEventCount: context.database.db.select().from(decisionEvents).all().length,
        idempotencyCount: context.database.db.select().from(idempotencyRecords).all().length,
        imageCount: context.database.db.select().from(images).all().length,
        session: context.database.db.select().from(sessions).all()[0],
      };

      const retryResponse = await route.POST(
        jsonRequest({ ...firstBody, labelImageIds: [crypto.randomUUID()] }),
        routeContext,
      );

      expect(retryResponse.status).toBe(409);
      expect(await retryResponse.json()).toMatchObject({
        error: { code: "IDEMPOTENCY_KEY_REUSED" },
      });
      expect(provider.calls).toBe(1);
      expect({
        ingredientCount: context.database.db.select().from(ingredients).all().length,
        decisionEventCount: context.database.db.select().from(decisionEvents).all().length,
        idempotencyCount: context.database.db.select().from(idempotencyRecords).all().length,
        imageCount: context.database.db.select().from(images).all().length,
        session: context.database.db.select().from(sessions).all()[0],
      }).toEqual(beforeRetry);
    } finally {
      context.database.cleanup();
    }
  });

  it("runs a same-body concurrent request once and replays the committed result", async () => {
    const context = createScanContext();
    const provider = new BlockingVisionProvider();
    const input = recognitionInput(context);
    const first = recognizeIngredients(context.unitOfWork, provider, input);
    const replay = recognizeIngredients(context.unitOfWork, provider, input);

    try {
      await Promise.resolve();
      expect(provider.calls).toBe(1);
      provider.release();

      const [firstResult, replayResult] = await Promise.all([first, replay]);
      expect(firstResult.response).toEqual(replayResult.response);
      expect([firstResult.replayed, replayResult.replayed].sort()).toEqual([false, true]);
      expect(provider.calls).toBe(1);
      expect(context.database.db.select().from(ingredients).all()).toHaveLength(2);
      expect(context.database.db.select().from(decisionEvents).all()).toHaveLength(1);
      expect(context.database.db.select().from(idempotencyRecords).all()).toHaveLength(3);
      expect(context.database.db.select().from(sessions).all()[0]?.version).toBe(2);
    } finally {
      provider.release();
      await Promise.allSettled([first, replay]);
      context.database.cleanup();
    }
  });

  it("gives only one concurrent different-body request execution rights", async () => {
    const context = createScanContext();
    const provider = new BlockingVisionProvider();
    const labelImageId = crypto.randomUUID();
    context.database.db
      .insert(images)
      .values({
        id: labelImageId,
        sessionId: context.sessionId,
        role: "label_closeup",
        objectKey: `${context.sessionId}/label_closeup-${labelImageId}.jpg`,
        mime: "image/jpeg",
        width: 100,
        height: 80,
      })
      .run();
    const requestId = crypto.randomUUID();
    const firstInput = {
      sessionId: context.sessionId,
      requestId,
      expectedVersion: context.expectedVersion,
      overviewImageId: context.overviewImageId,
      labelImageIds: [],
    };
    const secondInput = { ...firstInput, labelImageIds: [labelImageId] };
    const first = recognizeIngredients(context.unitOfWork, provider, firstInput);
    const conflict = recognizeIngredients(context.unitOfWork, provider, secondInput);

    try {
      await Promise.resolve();
      expect(provider.calls).toBe(1);
      await expect(conflict).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      provider.release();
      await first;

      expect(provider.calls).toBe(1);
      expect(context.database.db.select().from(ingredients).all()).toHaveLength(2);
      expect(context.database.db.select().from(decisionEvents).all()).toHaveLength(1);
      expect(context.database.db.select().from(idempotencyRecords).all()).toHaveLength(3);
      expect(context.database.db.select().from(sessions).all()[0]?.version).toBe(2);
    } finally {
      provider.release();
      await Promise.allSettled([first, conflict]);
      context.database.cleanup();
    }
  });

  it("rejects a stale recognition version before invoking the provider", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      await expect(
        recognizeIngredients(context.unitOfWork, provider, {
          ...recognitionInput(context),
          expectedVersion: 0,
        }),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      expect(provider.calls).toBe(0);
    } finally {
      context.database.cleanup();
    }
  });
});

describe("confirmIngredients application", () => {
  it("persists user corrections and additions, then advances CONFIRM to READY", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();
    const requestId = crypto.randomUUID();

    try {
      await recognizeIngredients(context.unitOfWork, provider, recognitionInput(context));
      const result = await confirmIngredients(context.unitOfWork, {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: 2,
        ingredients: confirmedIngredients,
      });
      const replay = await confirmIngredients(context.unitOfWork, {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: 2,
        ingredients: confirmedIngredients,
      });

      expect(result.replayed).toBe(false);
      expect(result.response.data.ingredients).toEqual(confirmedIngredients);
      expect(result.response.session).toMatchObject({ state: "READY", version: 3 });
      expect(replay.replayed).toBe(true);
      expect(replay.response).toEqual(result.response);
      expect(context.database.db.select().from(ingredients).all()).toHaveLength(2);
      expect(context.database.db.select().from(decisionEvents).all()).toHaveLength(2);
      expect(context.database.db.select().from(sessions).all()[0]?.version).toBe(3);
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects unconfirmed materials without changing the session", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      await recognizeIngredients(context.unitOfWork, provider, recognitionInput(context));
      await expect(
        confirmIngredients(context.unitOfWork, {
          sessionId: context.sessionId,
          requestId: crypto.randomUUID(),
          expectedVersion: 2,
          ingredients: [{ ...confirmedIngredients[0], confirmed: false }],
        }),
      ).rejects.toMatchObject({ code: "INGREDIENT_CONFIRMATION_REQUIRED" });

      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "CONFIRM",
        version: 2,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects a confirmed alcohol ingredient with unknown ABV", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      await recognizeIngredients(context.unitOfWork, provider, recognitionInput(context));
      await expect(
        confirmIngredients(context.unitOfWork, {
          sessionId: context.sessionId,
          requestId: crypto.randomUUID(),
          expectedVersion: 2,
          ingredients: [{ ...confirmedIngredients[0], abv: null }],
        }),
      ).rejects.toMatchObject({ code: "ABV_REQUIRED" });
    } finally {
      context.database.cleanup();
    }
  });

  it("requires explicit category selection even for a known alcohol brand", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      await recognizeIngredients(context.unitOfWork, provider, recognitionInput(context));
      await expect(
        confirmIngredients(context.unitOfWork, {
          sessionId: context.sessionId,
          requestId: crypto.randomUUID(),
          expectedVersion: 2,
          ingredients: [
            {
              ...confirmedIngredients[0],
              rawName: "茅台",
              canonicalName: "茅台",
              category: "unknown",
              abv: null,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "INGREDIENT_CATEGORY_REQUIRED" });
    } finally {
      context.database.cleanup();
    }
  });

  it("does not use an alcohol brand list to resolve an unknown category", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      await recognizeIngredients(context.unitOfWork, provider, recognitionInput(context));
      await expect(
        confirmIngredients(context.unitOfWork, {
          sessionId: context.sessionId,
          requestId: crypto.randomUUID(),
          expectedVersion: 2,
          ingredients: [
            {
              ...confirmedIngredients[0],
              rawName: "神秘饮料",
              canonicalName: "神秘饮料",
              category: "unknown",
              brand: "茅台",
              abv: null,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "INGREDIENT_CATEGORY_REQUIRED" });
    } finally {
      context.database.cleanup();
    }
  });

  it("blocks unknown Heineken without ABV before READY", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      await expect(
        confirmAfterRecognition(context, provider, [
          {
            ...confirmedIngredients[0],
            rawName: "Heineken",
            canonicalName: "Heineken",
            category: "unknown",
            brand: "Heineken",
            abv: null,
          },
        ]),
      ).rejects.toMatchObject({ code: "INGREDIENT_CATEGORY_REQUIRED" });
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "CONFIRM",
        version: 2,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("blocks an unknown category with a brand absent from alcohol lists", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      await expect(
        confirmAfterRecognition(context, provider, [
          {
            ...confirmedIngredients[1],
            rawName: "神秘饮料",
            canonicalName: "神秘饮料",
            category: "unknown",
            brand: "CompletelyNewBrewery",
            abv: null,
          },
        ]),
      ).rejects.toMatchObject({ code: "INGREDIENT_CATEGORY_REQUIRED" });
    } finally {
      context.database.cleanup();
    }
  });

  it("blocks an unknown category without a brand before READY", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      await expect(
        confirmAfterRecognition(context, provider, [
          {
            ...confirmedIngredients[1],
            rawName: "未分类材料",
            canonicalName: "未分类材料",
            category: "unknown",
            brand: null,
            abv: null,
          },
        ]),
      ).rejects.toMatchObject({ code: "INGREDIENT_CATEGORY_REQUIRED" });
    } finally {
      context.database.cleanup();
    }
  });

  it("allows a confirmed controlled non-alcohol category to reach READY", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      const result = await confirmAfterRecognition(context, provider, [
        {
          ...confirmedIngredients[1],
          rawName: "用户确认的苏打水",
          canonicalName: "用户确认的苏打水",
          category: "mixer",
          brand: null,
          abv: null,
        },
      ]);

      expect(result.response.session).toMatchObject({ state: "READY", version: 3 });
    } finally {
      context.database.cleanup();
    }
  });

  it("blocks a recategorized alcohol ingredient until ABV is provided", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      await expect(
        confirmAfterRecognition(context, provider, [
          {
            ...confirmedIngredients[1],
            rawName: "Tequila",
            canonicalName: "Tequila",
            category: "spirit",
            brand: "CompletelyNewBrand",
            abv: null,
          },
        ]),
      ).rejects.toMatchObject({ code: "ABV_REQUIRED" });
    } finally {
      context.database.cleanup();
    }
  });

  it("allows a recategorized alcohol ingredient with confirmed ABV to reach READY", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      const result = await confirmAfterRecognition(context, provider, [
        {
          ...confirmedIngredients[1],
          rawName: "Tequila",
          canonicalName: "Tequila",
          category: "spirit",
          brand: "CompletelyNewBrand",
          abv: 40,
        },
      ]);

      expect(result.response.session).toMatchObject({ state: "READY", version: 3 });
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects an invalid ingredient category enum", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      await expect(
        confirmAfterRecognition(context, provider, [
          {
            ...confirmedIngredients[1],
            category: "unknownbu",
          },
        ]),
      ).rejects.toBeInstanceOf(ZodError);
    } finally {
      context.database.cleanup();
    }
  });
});

describe("Task 8 route handlers", () => {
  it("runs recognition and confirmation through thin JSON handlers", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      const recognitionResponse = await createRecognitionRouteHandlers(
        context.unitOfWork,
        provider,
      ).POST(
        jsonRequest({
          requestId: crypto.randomUUID(),
          expectedVersion: context.expectedVersion,
          overviewImageId: context.overviewImageId,
          labelImageIds: [],
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(recognitionResponse.status).toBe(200);
      expect((await recognitionResponse.json()).session).toMatchObject({
        state: "CONFIRM",
        version: 2,
      });

      const ingredientResponse = await createIngredientConfirmationRouteHandlers(
        context.unitOfWork,
      ).PUT(
        jsonRequest(
          {
            requestId: crypto.randomUUID(),
            expectedVersion: 2,
            ingredients: confirmedIngredients,
          },
          "PUT",
        ),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(ingredientResponse.status).toBe(200);
      expect((await ingredientResponse.json()).session).toMatchObject({
        state: "READY",
        version: 3,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("maps provider failure to retryable 503 while keeping the image", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider(visionResult, new Error("provider offline"));

    try {
      const response = await createRecognitionRouteHandlers(context.unitOfWork, provider).POST(
        jsonRequest({
          requestId: crypto.randomUUID(),
          expectedVersion: context.expectedVersion,
          overviewImageId: context.overviewImageId,
          labelImageIds: [],
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "PROVIDER_UNAVAILABLE", retryable: true },
      });
      expect(context.database.db.select().from(images).all()).toHaveLength(1);
    } finally {
      context.database.cleanup();
    }
  });

  it("maps an unclassified ingredient to a stable category-required response", async () => {
    const context = createScanContext();
    const provider = new RecordingVisionProvider();

    try {
      const recognitionResponse = await createRecognitionRouteHandlers(
        context.unitOfWork,
        provider,
      ).POST(
        jsonRequest({
          requestId: crypto.randomUUID(),
          expectedVersion: context.expectedVersion,
          overviewImageId: context.overviewImageId,
          labelImageIds: [],
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(recognitionResponse.status).toBe(200);

      const response = await createIngredientConfirmationRouteHandlers(context.unitOfWork).PUT(
        jsonRequest(
          {
            requestId: crypto.randomUUID(),
            expectedVersion: 2,
            ingredients: [
              {
                ...confirmedIngredients[1],
                rawName: "Heineken",
                canonicalName: "Heineken",
                category: "unknown",
                brand: "Heineken",
                abv: null,
              },
            ],
          },
          "PUT",
        ),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: "INGREDIENT_CATEGORY_REQUIRED" },
      });
    } finally {
      context.database.cleanup();
    }
  });
});
