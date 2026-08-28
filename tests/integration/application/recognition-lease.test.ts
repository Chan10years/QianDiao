import { describe, expect, it } from "vitest";

import { fingerprintRequest } from "@/src/application/idempotency";
import { recognizeIngredients } from "@/src/application/recognize-ingredients";
import {
  createSessionUnitOfWork,
  type VisionTransactionRepository,
  type VisionUnitOfWork,
} from "@/src/application/unit-of-work";
import { createSession } from "@/src/application/create-session";
import { savePreferences } from "@/src/application/save-preferences";
import {
  idempotencyRecords,
  ingredients,
  decisionEvents,
  images,
  sessions,
} from "@/src/infrastructure/db/schema";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase, type TestDatabase } from "@/tests/helpers/test-database";
import type { VisionProvider, VisionResult } from "@/src/providers/vision-provider";
import type { Clock } from "@/src/application/clock";

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
  ],
  needsLabelCloseup: true,
  userQuestions: ["请确认酒精度（ABV）。"],
  sourceMode: "fallback",
};

class TestVisionProvider implements VisionProvider {
  calls = 0;
  private blockedCalls = 0;
  private readonly pending: Array<(result: VisionResult) => void> = [];

  constructor(private readonly failure: Error | null = null) {}

  async recognize(): Promise<VisionResult> {
    this.calls += 1;
    if (this.failure !== null) {
      throw this.failure;
    }

    if (this.blockedCalls > 0) {
      this.blockedCalls -= 1;
      return new Promise<VisionResult>((resolve) => this.pending.push(resolve));
    }

    return visionResult;
  }

  blockNextCall(): void {
    this.blockedCalls += 1;
  }

  release(): void {
    const resolve = this.pending.shift();
    if (resolve !== undefined) {
      resolve(visionResult);
    }
  }
}

class ManualClock implements Clock {
  private currentTime = 0;

  now(): Date {
    return new Date(this.currentTime);
  }

  advance(milliseconds: number): void {
    this.currentTime += milliseconds;
  }
}

interface ScanContext {
  database: TestDatabase;
  unitOfWork: VisionUnitOfWork;
  sessionId: string;
  expectedVersion: number;
  overviewImageId: string;
}

function createScanContext(): ScanContext {
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
    unitOfWork,
    sessionId: created.response.session.id,
    expectedVersion: preferences.response.session.version,
    overviewImageId,
  };
}

function recognitionInput(context: ScanContext, requestId = crypto.randomUUID()) {
  return {
    sessionId: context.sessionId,
    requestId,
    expectedVersion: context.expectedVersion,
    overviewImageId: context.overviewImageId,
    labelImageIds: [],
  };
}

function seedLegacyPendingReservation(
  context: ScanContext,
  input: ReturnType<typeof recognitionInput>,
): void {
  const requestFingerprint = fingerprintRequest({
    operation: "recognize-ingredients",
    sessionId: input.sessionId,
    expectedVersion: input.expectedVersion,
    overviewImageId: input.overviewImageId,
    labelImageIds: input.labelImageIds,
  });

  context.unitOfWork.transactionVision((repository) => {
    repository.saveIdempotencyRecord({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      requestId: input.requestId,
      requestFingerprint,
      response: { pending: true },
      statusCode: 102,
    });
  });
}

function seedExpiredReservation(
  context: ScanContext,
  input: ReturnType<typeof recognitionInput>,
  clock: ManualClock,
): void {
  const requestFingerprint = fingerprintRequest({
    operation: "recognize-ingredients",
    sessionId: input.sessionId,
    expectedVersion: input.expectedVersion,
    overviewImageId: input.overviewImageId,
    labelImageIds: input.labelImageIds,
  });

  context.unitOfWork.transactionVision((repository) => {
    repository.acquireIdempotencyLease({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      requestId: input.requestId,
      requestFingerprint,
      expectedVersion: input.expectedVersion,
      response: { pending: true },
      statusCode: 102,
      leaseOwner: "abandoned-owner",
      leaseExpiresAt: new Date(1_000),
      now: new Date(0),
    });
  });
  clock.advance(1_001);
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

function leaseOptions(clock: ManualClock) {
  return {
    clock,
    leaseDurationMs: 1_000,
    maxWaitAttempts: 20,
    sleep: async () => undefined,
  };
}

function settle<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function withFailingCleanup(unitOfWork: VisionUnitOfWork): VisionUnitOfWork {
  return {
    ...unitOfWork,
    transactionVision<T>(operation: (repository: VisionTransactionRepository) => T): T {
      return unitOfWork.transactionVision((repository) =>
        operation({
          ...repository,
          deleteIdempotencyRecord: () => {
            throw new Error("CLEANUP_FAILED");
          },
        }),
      );
    },
  };
}

describe("recognizeIngredients reservation leases", () => {
  it("retries a legacy pending reservation instead of waiting forever", async () => {
    const context = createScanContext();
    const clock = new ManualClock();
    const input = recognitionInput(context);
    seedLegacyPendingReservation(context, input);
    const provider = new TestVisionProvider();
    const pending = recognizeIngredients(context.unitOfWork, provider, input, leaseOptions(clock));
    const pendingOutcome = settle(pending);

    try {
      await flushAsyncWork();
      expect(await pendingOutcome).toMatchObject({ value: { replayed: false } });
      expect(provider.calls).toBe(1);
    } finally {
      await Promise.allSettled([pending]);
      context.database.cleanup();
    }
  });

  it("allows only one concurrent takeover of an expired pending reservation", async () => {
    const context = createScanContext();
    const clock = new ManualClock();
    const input = recognitionInput(context);
    seedExpiredReservation(context, input, clock);
    const provider = new TestVisionProvider();
    const first = recognizeIngredients(context.unitOfWork, provider, input, leaseOptions(clock));
    const second = recognizeIngredients(context.unitOfWork, provider, input, leaseOptions(clock));
    const resultsOutcome = settle(Promise.all([first, second]));

    try {
      await flushAsyncWork();
      const results = await resultsOutcome;
      expect(results).toMatchObject({ value: expect.any(Array) });
      if ("value" in results) {
        expect(results.value.map((result) => result.replayed).sort()).toEqual([false, true]);
      }
      expect(provider.calls).toBe(1);
    } finally {
      await Promise.allSettled([first, second]);
      context.database.cleanup();
    }
  });

  it("prevents an old owner from committing or deleting a replacement owner's reservation", async () => {
    const context = createScanContext();
    const clock = new ManualClock();
    const input = recognitionInput(context);
    const provider = new TestVisionProvider();
    provider.blockNextCall();
    provider.blockNextCall();
    const oldOwner = recognizeIngredients(context.unitOfWork, provider, input, leaseOptions(clock));
    const oldOwnerOutcome = settle(oldOwner);
    let newOwner: Promise<Awaited<ReturnType<typeof recognizeIngredients>>> | null = null;

    try {
      await Promise.resolve();
      expect(provider.calls).toBe(1);
      clock.advance(1_001);
      newOwner = recognizeIngredients(context.unitOfWork, provider, input, leaseOptions(clock));
      const newOwnerOutcome = settle(newOwner);
      await flushAsyncWork();

      provider.release();
      const oldResult = await oldOwnerOutcome;
      expect(oldResult).toMatchObject({ error: { code: "IDEMPOTENCY_LEASE_LOST" } });
      expect(provider.calls).toBe(2);
      expect(context.database.db.select().from(ingredients).all()).toHaveLength(0);
      expect(context.database.db.select().from(decisionEvents).all()).toHaveLength(0);
      expect(context.database.db.select().from(sessions).all()[0]?.version).toBe(1);
      expect(context.database.db.select().from(idempotencyRecords).all()).toHaveLength(3);

      provider.release();
      expect(await newOwnerOutcome).toMatchObject({ value: { replayed: false } });
      expect(context.database.db.select().from(ingredients).all()).toHaveLength(1);
      expect(context.database.db.select().from(decisionEvents).all()).toHaveLength(1);
      expect(context.database.db.select().from(sessions).all()[0]?.version).toBe(2);
      expect(context.database.db.select().from(idempotencyRecords).all()).toHaveLength(3);
    } finally {
      provider.release();
      if (newOwner !== null) {
        await Promise.allSettled([newOwner]);
      }
      await Promise.allSettled([oldOwner]);
      context.database.cleanup();
    }
  });

  it("does not let a different fingerprint take over an expired reservation", async () => {
    const context = createScanContext();
    const clock = new ManualClock();
    const requestId = crypto.randomUUID();
    const firstInput = recognitionInput(context, requestId);
    seedExpiredReservation(context, firstInput, clock);
    const provider = new TestVisionProvider();
    const differentInput = { ...firstInput, labelImageIds: [crypto.randomUUID()] };

    try {
      await expect(
        recognizeIngredients(context.unitOfWork, provider, differentInput, leaseOptions(clock)),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      expect(provider.calls).toBe(0);
      expect(context.database.db.select().from(ingredients).all()).toHaveLength(0);
      expect(context.database.db.select().from(decisionEvents).all()).toHaveLength(0);
      expect(context.database.db.select().from(sessions).all()[0]?.version).toBe(1);
    } finally {
      context.database.cleanup();
    }
  });

  it("surfaces reservation cleanup failure and allows recovery after expiry", async () => {
    const context = createScanContext();
    const clock = new ManualClock();
    const input = recognitionInput(context);
    const failingProvider = new TestVisionProvider(new Error("provider offline"));

    try {
      const failure = await settle(
        recognizeIngredients(
          withFailingCleanup(context.unitOfWork),
          failingProvider,
          input,
          leaseOptions(clock),
        ),
      );
      expect(failure).toMatchObject({ error: { code: "IDEMPOTENCY_CLEANUP_FAILED" } });
      expect(failingProvider.calls).toBe(1);

      clock.advance(1_001);
      const recoveryProvider = new TestVisionProvider();
      await expect(
        recognizeIngredients(context.unitOfWork, recoveryProvider, input, leaseOptions(clock)),
      ).resolves.toMatchObject({ replayed: false });
      expect(recoveryProvider.calls).toBe(1);
    } finally {
      context.database.cleanup();
    }
  });

  it("replays normal concurrent recognition once without duplicate writes", async () => {
    const context = createScanContext();
    const clock = new ManualClock();
    const input = recognitionInput(context);
    const provider = new TestVisionProvider();
    const first = recognizeIngredients(context.unitOfWork, provider, input, leaseOptions(clock));
    const second = recognizeIngredients(context.unitOfWork, provider, input, leaseOptions(clock));

    try {
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.response).toEqual(secondResult.response);
      expect(provider.calls).toBe(1);
      expect(context.database.db.select().from(ingredients).all()).toHaveLength(1);
      expect(context.database.db.select().from(decisionEvents).all()).toHaveLength(1);
      expect(context.database.db.select().from(idempotencyRecords).all()).toHaveLength(3);
      expect(context.database.db.select().from(sessions).all()[0]?.version).toBe(2);
    } finally {
      await Promise.allSettled([first, second]);
      context.database.cleanup();
    }
  });
});
