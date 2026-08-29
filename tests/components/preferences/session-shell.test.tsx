// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionShell } from "@/components/session/session-shell";
import {
  SessionClientError,
  type RecognitionResult,
  type SessionClientLike,
  type SessionSnapshot,
  type UploadOverviewImageResult,
} from "@/src/infrastructure/http/session-client";

const preferencesSnapshot: SessionSnapshot = {
  data: {
    preferences: { sweetness: 3, acidity: 3, alcoholIntensity: 3, body: 3 },
    selectedRecipeId: null,
    currentStep: null,
    ingredients: [],
    mixingPhotos: [],
  },
  session: {
    id: "123e4567-e89b-12d3-a456-426614174000",
    state: "PREFERENCES",
    version: 0,
  },
};

const scanSnapshot: SessionSnapshot = {
  ...preferencesSnapshot,
  session: { ...preferencesSnapshot.session, state: "SCAN", version: 1 },
};

const persistedIngredient = {
  rawName: "二锅头",
  canonicalName: "白酒",
  category: "spirit" as const,
  brand: null,
  abv: 42,
  confidence: 0.72,
  confirmed: false,
};

describe("SessionShell", () => {
  afterEach(() => cleanup());

  it("renders the screen represented by the latest server snapshot after saving preferences", async () => {
    const user = userEvent.setup();
    const client: SessionClientLike = {
      getSession: vi.fn().mockResolvedValue(preferencesSnapshot),
      getRecipeSet: vi.fn(),
      savePreferences: vi.fn().mockResolvedValue(scanSnapshot),
      uploadOverviewImage: vi.fn(),
      recognizeIngredients: vi.fn(),
      confirmIngredients: vi.fn(),
      generateRecipeSet: vi.fn(),
      selectRecipe: vi.fn(),
      advanceMixing: vi.fn(),
      uploadMixingStepImage: vi.fn(),
      getAdjustmentState: vi.fn(),
      saveFeedback: vi.fn(),
      generateAdjustment: vi.fn(),
      acceptAdjustment: vi.fn(),
    };

    render(<SessionShell sessionId={preferencesSnapshot.session.id} client={client} />);

    await screen.findByRole("heading", { name: "你想喝什么感觉？" });
    await user.click(screen.getByRole("button", { name: "保存口味，开始拍照" }));

    expect(await screen.findByRole("heading", { name: "拍照桌面材料" })).toBeInTheDocument();
    expect(client.savePreferences).toHaveBeenCalledWith({
      sessionId: preferencesSnapshot.session.id,
      expectedVersion: 0,
      preferences: preferencesSnapshot.data.preferences,
    });
  });

  it("refreshes the authoritative snapshot after a preference version conflict", async () => {
    const user = userEvent.setup();
    const latestSnapshot: SessionSnapshot = {
      ...scanSnapshot,
      data: { ...scanSnapshot.data, ingredients: [] },
      session: { ...scanSnapshot.session, version: 2 },
    };
    const client: SessionClientLike = {
      getSession: vi
        .fn()
        .mockResolvedValueOnce(preferencesSnapshot)
        .mockResolvedValueOnce(latestSnapshot),
      getRecipeSet: vi.fn(),
      savePreferences: vi
        .fn()
        .mockRejectedValue(
          new SessionClientError("VERSION_CONFLICT", "会话版本已过期，请重新加载", true),
        ),
      uploadOverviewImage: vi.fn(),
      recognizeIngredients: vi.fn(),
      confirmIngredients: vi.fn(),
      generateRecipeSet: vi.fn(),
      selectRecipe: vi.fn(),
      advanceMixing: vi.fn(),
      uploadMixingStepImage: vi.fn(),
      getAdjustmentState: vi.fn(),
      saveFeedback: vi.fn(),
      generateAdjustment: vi.fn(),
      acceptAdjustment: vi.fn(),
    };

    render(<SessionShell sessionId={preferencesSnapshot.session.id} client={client} />);
    await screen.findByRole("heading", { name: "你想喝什么感觉？" });
    await user.click(screen.getByRole("button", { name: "保存口味，开始拍照" }));

    expect(await screen.findByRole("heading", { name: "拍照桌面材料" })).toBeInTheDocument();
    expect(client.getSession).toHaveBeenCalledTimes(2);
  });

  it("initializes CONFIRM from the ingredients in the refreshed snapshot", async () => {
    const confirmSnapshot: SessionSnapshot = {
      ...scanSnapshot,
      data: { ...scanSnapshot.data, ingredients: [persistedIngredient] },
      session: { ...scanSnapshot.session, state: "CONFIRM", version: 2 },
    };
    const client: SessionClientLike = {
      getSession: vi.fn().mockResolvedValue(confirmSnapshot),
      getRecipeSet: vi.fn(),
      savePreferences: vi.fn(),
      uploadOverviewImage: vi.fn(),
      recognizeIngredients: vi.fn(),
      confirmIngredients: vi.fn(),
      generateRecipeSet: vi.fn(),
      selectRecipe: vi.fn(),
      advanceMixing: vi.fn(),
      uploadMixingStepImage: vi.fn(),
      getAdjustmentState: vi.fn(),
      saveFeedback: vi.fn(),
      generateAdjustment: vi.fn(),
      acceptAdjustment: vi.fn(),
    };

    render(<SessionShell sessionId={confirmSnapshot.session.id} client={client} />);

    expect(await screen.findByRole("heading", { name: "确认材料" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("白酒")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认材料并继续" })).toBeDisabled();
  });

  it("invalidates the old upload after a scan version conflict and reuploads on the next click", async () => {
    const user = userEvent.setup();
    const uploadedFile = new File(["jpeg"], "桌面.jpg", { type: "image/jpeg" });
    const firstUpload: UploadOverviewImageResult = {
      image: {
        id: "323e4567-e89b-12d3-a456-426614174000",
        role: "overview",
        mime: "image/jpeg",
        width: 1200,
        height: 800,
      },
      session: { id: preferencesSnapshot.session.id, state: "SCAN", version: 2 },
    };
    const secondUpload: UploadOverviewImageResult = {
      ...firstUpload,
      image: { ...firstUpload.image, id: "423e4567-e89b-12d3-a456-426614174000" },
      session: { ...firstUpload.session, version: 4 },
    };
    const finalRecognition: RecognitionResult = {
      recognition: {
        ingredients: [persistedIngredient],
        needsLabelCloseup: false,
        userQuestions: [],
        sourceMode: "fallback",
      },
      session: { id: preferencesSnapshot.session.id, state: "CONFIRM", version: 5 },
    };
    const scanVersionThree: SessionSnapshot = {
      ...scanSnapshot,
      session: { ...scanSnapshot.session, version: 3 },
    };
    const uploadOverviewImage = vi
      .fn<SessionClientLike["uploadOverviewImage"]>()
      .mockResolvedValueOnce(firstUpload)
      .mockResolvedValueOnce(secondUpload);
    const recognizeIngredients = vi
      .fn<SessionClientLike["recognizeIngredients"]>()
      .mockRejectedValueOnce(
        new SessionClientError("VERSION_CONFLICT", "会话版本已过期，请重新加载", true),
      )
      .mockResolvedValueOnce(finalRecognition);
    const client: SessionClientLike = {
      getSession: vi
        .fn()
        .mockResolvedValueOnce(scanSnapshot)
        .mockResolvedValueOnce(scanVersionThree),
      getRecipeSet: vi.fn(),
      savePreferences: vi.fn(),
      uploadOverviewImage,
      recognizeIngredients,
      confirmIngredients: vi.fn(),
      generateRecipeSet: vi.fn(),
      selectRecipe: vi.fn(),
      advanceMixing: vi.fn(),
      uploadMixingStepImage: vi.fn(),
      getAdjustmentState: vi.fn(),
      saveFeedback: vi.fn(),
      generateAdjustment: vi.fn(),
      acceptAdjustment: vi.fn(),
    };

    render(<SessionShell sessionId={scanSnapshot.session.id} client={client} />);
    await screen.findByRole("heading", { name: "拍照桌面材料" });

    await user.upload(screen.getByLabelText("选择桌面照片"), uploadedFile);
    await user.click(screen.getByRole("button", { name: "上传照片并识别" }));

    await screen.findByRole("alert");
    expect(screen.getByText("桌面.jpg")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "桌面材料预览" })).toBeInTheDocument();
    expect(client.getSession).toHaveBeenCalledTimes(2);
    expect(recognizeIngredients).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "上传照片并识别" }));

    expect(await screen.findByRole("heading", { name: "确认材料" })).toBeInTheDocument();
    expect(uploadOverviewImage).toHaveBeenCalledTimes(2);
    expect(uploadOverviewImage).toHaveBeenNthCalledWith(2, {
      sessionId: scanSnapshot.session.id,
      expectedVersion: 3,
      file: uploadedFile,
    });
    expect(recognizeIngredients).toHaveBeenNthCalledWith(2, {
      sessionId: scanSnapshot.session.id,
      expectedVersion: secondUpload.session.version,
      overviewImageId: secondUpload.image.id,
      labelImageIds: [],
    });
  });

  it("does not reupload when conflict recovery already moved the session beyond SCAN", async () => {
    const user = userEvent.setup();
    const uploadOverviewImage = vi.fn().mockResolvedValue({
      image: {
        id: "523e4567-e89b-12d3-a456-426614174000",
        role: "overview",
        mime: "image/jpeg",
        width: 1200,
        height: 800,
      },
      session: { id: scanSnapshot.session.id, state: "SCAN", version: 2 },
    } satisfies UploadOverviewImageResult);
    const latestConfirmSnapshot: SessionSnapshot = {
      ...scanSnapshot,
      data: { ...scanSnapshot.data, ingredients: [persistedIngredient] },
      session: { ...scanSnapshot.session, state: "CONFIRM", version: 3 },
    };
    const client: SessionClientLike = {
      getSession: vi
        .fn()
        .mockResolvedValueOnce(scanSnapshot)
        .mockResolvedValueOnce(latestConfirmSnapshot),
      getRecipeSet: vi.fn(),
      savePreferences: vi.fn(),
      uploadOverviewImage,
      recognizeIngredients: vi
        .fn()
        .mockRejectedValue(
          new SessionClientError("VERSION_CONFLICT", "会话版本已过期，请重新加载", true),
        ),
      confirmIngredients: vi.fn(),
      generateRecipeSet: vi.fn(),
      selectRecipe: vi.fn(),
      advanceMixing: vi.fn(),
      uploadMixingStepImage: vi.fn(),
      getAdjustmentState: vi.fn(),
      saveFeedback: vi.fn(),
      generateAdjustment: vi.fn(),
      acceptAdjustment: vi.fn(),
    };

    render(<SessionShell sessionId={scanSnapshot.session.id} client={client} />);
    await screen.findByRole("heading", { name: "拍照桌面材料" });
    await user.upload(
      screen.getByLabelText("选择桌面照片"),
      new File(["jpeg"], "桌面.jpg", { type: "image/jpeg" }),
    );
    await user.click(screen.getByRole("button", { name: "上传照片并识别" }));

    expect(await screen.findByRole("heading", { name: "确认材料" })).toBeInTheDocument();
    expect(uploadOverviewImage).toHaveBeenCalledTimes(1);
    expect(client.recognizeIngredients).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "上传照片并识别" })).not.toBeInTheDocument();
  });
});
