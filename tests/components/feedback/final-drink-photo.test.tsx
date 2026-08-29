// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionShell } from "@/components/session/session-shell";
import { RecipeCandidateSchema } from "@/src/domain/recipe";
import {
  SessionClientError,
  type AdjustmentStateSnapshot,
  type SaveFeedbackResult,
  type SessionClientLike,
  type SessionSnapshot,
  type UploadFinalDrinkImageResult,
  type VersionedRecipeReadModel,
} from "@/src/infrastructure/http/session-client";
import { makeDomainFixtures } from "@/tests/fixtures/domain";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";
const feedbackId = "723e4567-e89b-12d3-a456-426614174000";
const finalImageId = "623e4567-e89b-12d3-a456-426614174000";

interface FinalDrinkFixture {
  snapshot: SessionSnapshot;
  adjustmentState: AdjustmentStateSnapshot;
  currentRecipe: VersionedRecipeReadModel;
  uploadResult: UploadFinalDrinkImageResult;
  satisfiedResult: SaveFeedbackResult;
}

function createFixture(): FinalDrinkFixture {
  const fixtures = makeDomainFixtures();
  const candidate = RecipeCandidateSchema.parse({
    ...fixtures.recipes[0],
    steps: [
      { order: 1, instruction: "先加入冰块并降温。", isPhotoCheckpoint: false },
      { order: 2, instruction: "再分次加入白酒并轻轻搅拌。", isPhotoCheckpoint: false },
      { order: 3, instruction: "最后用柠檬片点缀。", isPhotoCheckpoint: false },
    ],
  });
  const currentRecipe: VersionedRecipeReadModel = {
    recipeId: candidate.id,
    recipeSetId: "223e4567-e89b-12d3-a456-426614174000",
    candidate,
    version: 1,
    parentRecipeId: null,
    feedbackId: null,
    safety: { level: "ALLOW", reasons: ["无已知规则命中。"], alternatives: [] },
    isSelected: true,
  };

  return {
    snapshot: {
      data: {
        preferences: fixtures.tasteProfile,
        selectedRecipeId: currentRecipe.recipeId,
        currentStep: null,
        ingredients: [],
        mixingPhotos: [],
      },
      session: { id: sessionId, state: "FEEDBACK", version: 5 },
    },
    adjustmentState: {
      data: { currentRecipe, proposal: null, pendingFeedbackId: null },
      session: { id: sessionId, state: "FEEDBACK", version: 5 },
    },
    currentRecipe,
    uploadResult: {
      image: {
        id: finalImageId,
        role: "final_drink",
        mime: "image/jpeg",
        width: 100,
        height: 100,
      },
      session: { id: sessionId, state: "FEEDBACK", version: 6 },
    },
    satisfiedResult: {
      sessionId,
      state: "COMPLETED",
      sessionVersion: 7,
      feedbackId,
      finalImageId,
      session: { id: sessionId, state: "COMPLETED", version: 7 },
    },
  };
}

function createClient(
  fixture: FinalDrinkFixture,
  overrides: Partial<{
    uploadFinalDrinkImage: SessionClientLike["uploadFinalDrinkImage"];
    saveFeedback: SessionClientLike["saveFeedback"];
  }> = {},
) {
  return {
    getSession: vi.fn().mockResolvedValue(fixture.snapshot),
    getRecipeSet: vi.fn(),
    getAdjustmentState: vi.fn().mockResolvedValue(fixture.adjustmentState),
    savePreferences: vi.fn(),
    uploadOverviewImage: vi.fn(),
    uploadFinalDrinkImage: vi.fn().mockResolvedValue(fixture.uploadResult),
    uploadMixingStepImage: vi.fn(),
    recognizeIngredients: vi.fn(),
    confirmIngredients: vi.fn(),
    generateRecipeSet: vi.fn(),
    selectRecipe: vi.fn(),
    advanceMixing: vi.fn(),
    saveFeedback: vi.fn().mockResolvedValue(fixture.satisfiedResult),
    generateAdjustment: vi.fn(),
    acceptAdjustment: vi.fn(),
    ...overrides,
  } as SessionClientLike;
}

async function enterSatisfiedClosing(client: SessionClientLike) {
  const user = userEvent.setup();
  render(<SessionShell sessionId={sessionId} client={client} />);
  await user.click(await screen.findByRole("button", { name: "满意" }));
  await screen.findByRole("heading", { name: "满意收尾" });
}

function selectFinalDrinkPhoto() {
  const file = new File(["final-drink"], "final-drink.jpg", { type: "image/jpeg" });
  fireEvent.change(screen.getByLabelText("选择成品照片"), { target: { files: [file] } });
  return file;
}

describe("final drink photo", () => {
  afterEach(() => cleanup());

  it("defers saving satisfied feedback until the user takes or skips the final drink photo", async () => {
    const fixture = createFixture();
    const client = createClient(fixture);

    await enterSatisfiedClosing(client);

    // 拍摄邀请与跳过出口都可见，但满意反馈尚未保存。
    expect(screen.getByRole("button", { name: "上传照片并完成" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "跳过，直接完成" })).toBeEnabled();
    expect(client.uploadFinalDrinkImage).not.toHaveBeenCalled();
    expect(client.saveFeedback).not.toHaveBeenCalled();
  });

  it("uploads the final drink photo then saves accepted=true with the image id and completes", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const client = createClient(fixture);

    await enterSatisfiedClosing(client);
    const file = selectFinalDrinkPhoto();

    await user.click(screen.getByRole("button", { name: "上传照片并完成" }));

    await waitFor(() => {
      expect(client.uploadFinalDrinkImage).toHaveBeenCalledWith({
        sessionId,
        expectedVersion: 5,
        file,
      });
    });

    await waitFor(() => {
      expect(client.saveFeedback).toHaveBeenCalledWith({
        sessionId,
        expectedVersion: 6,
        recipeId: fixture.currentRecipe.recipeId,
        feedback: {
          rating: 5,
          accepted: true,
          deltas: { sweetness: 0, acidity: 0, alcoholIntensity: 0, body: 0 },
          finalImageId,
        },
      });
    });

    expect(await screen.findByRole("heading", { name: "调饮完成" })).toBeInTheDocument();
    expect(screen.getByText(/V1/)).toBeInTheDocument();
  });

  it("skipping saves accepted=true with a null image id and completes without uploading", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const client = createClient(fixture, {
      saveFeedback: vi.fn().mockResolvedValue({
        ...fixture.satisfiedResult,
        finalImageId: null,
      }),
    });

    await enterSatisfiedClosing(client);

    await user.click(screen.getByRole("button", { name: "跳过，直接完成" }));

    await waitFor(() => {
      expect(client.saveFeedback).toHaveBeenCalledWith({
        sessionId,
        expectedVersion: 5,
        recipeId: fixture.currentRecipe.recipeId,
        feedback: {
          rating: 5,
          accepted: true,
          deltas: { sweetness: 0, acidity: 0, alcoholIntensity: 0, body: 0 },
          finalImageId: null,
        },
      });
    });
    expect(client.uploadFinalDrinkImage).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "调饮完成" })).toBeInTheDocument();
  });

  it("keeps retry and skip exits when the upload fails, and skipping still completes", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const client = createClient(fixture, {
      uploadFinalDrinkImage: vi
        .fn()
        .mockRejectedValueOnce(
          new SessionClientError("UPLOAD_FAILED", "成品照上传失败，请重试", true),
        ),
      saveFeedback: vi.fn().mockResolvedValue({
        ...fixture.satisfiedResult,
        finalImageId: null,
      }),
    });

    await enterSatisfiedClosing(client);
    selectFinalDrinkPhoto();

    await user.click(screen.getByRole("button", { name: "上传照片并完成" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(client.saveFeedback).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "跳过，直接完成" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "跳过，直接完成" }));

    await waitFor(() => {
      expect(client.saveFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          feedback: expect.objectContaining({ accepted: true, finalImageId: null }),
        }),
      );
    });
    expect(await screen.findByRole("heading", { name: "调饮完成" })).toBeInTheDocument();
  });

  it("retries the saved feedback without re-uploading the same photo", async () => {
    const user = userEvent.setup();
    const fixture = createFixture();
    const client = createClient(fixture, {
      saveFeedback: vi
        .fn()
        .mockRejectedValueOnce(new SessionClientError("NETWORK_ERROR", "网络异常，请重试", true))
        .mockResolvedValueOnce(fixture.satisfiedResult),
    });

    await enterSatisfiedClosing(client);
    selectFinalDrinkPhoto();

    await user.click(screen.getByRole("button", { name: "上传照片并完成" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(client.uploadFinalDrinkImage).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "上传照片并完成" }));

    await waitFor(() => {
      expect(client.saveFeedback).toHaveBeenCalledTimes(2);
    });
    expect(client.uploadFinalDrinkImage).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "调饮完成" })).toBeInTheDocument();
  });
});
