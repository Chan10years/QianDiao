// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CameraScreen } from "@/components/scan/camera-screen";
import type {
  RecognitionResult,
  SessionClientLike,
  UploadOverviewImageResult,
} from "@/src/infrastructure/http/session-client";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";

const uploadResult: UploadOverviewImageResult = {
  image: {
    id: "223e4567-e89b-12d3-a456-426614174000",
    role: "overview",
    mime: "image/jpeg",
    width: 1200,
    height: 800,
  },
  session: { id: sessionId, state: "SCAN", version: 2 },
};

const recognitionResult: RecognitionResult = {
  recognition: {
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
  },
  session: { id: sessionId, state: "CONFIRM", version: 3 },
};

function makeClient(overrides: Partial<SessionClientLike> = {}): SessionClientLike {
  return {
    getSession: vi.fn(),
    getRecipeSet: vi.fn(),
    savePreferences: vi.fn(),
    uploadOverviewImage: vi.fn().mockResolvedValue(uploadResult),
    recognizeIngredients: vi.fn().mockResolvedValue(recognitionResult),
    confirmIngredients: vi.fn(),
    generateRecipeSet: vi.fn(),
    selectRecipe: vi.fn(),
    advanceMixing: vi.fn(),
    uploadMixingStepImage: vi.fn(),
    ...overrides,
  };
}

describe("CameraScreen", () => {
  afterEach(() => cleanup());

  it("uses the mobile camera input contract and lets the user replace a preview", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(
      <CameraScreen
        sessionId={sessionId}
        expectedVersion={1}
        client={client}
        onRecognized={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("选择桌面照片");
    expect(input).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    expect(input).toHaveAttribute("capture", "environment");

    const firstFile = new File(["first"], "桌面-1.png", { type: "image/png" });
    const secondFile = new File(["second"], "桌面-2.webp", { type: "image/webp" });
    await user.upload(input, firstFile);
    expect(screen.getByRole("img", { name: "桌面材料预览" })).toBeInTheDocument();
    expect(screen.getByText("桌面-1.png")).toBeInTheDocument();

    await user.upload(input, secondFile);
    expect(screen.getByText("桌面-2.webp")).toBeInTheDocument();
    expect(screen.queryByText("桌面-1.png")).not.toBeInTheDocument();
  });

  it("shows an upload stage, then hands the recognition snapshot to the shell", async () => {
    const user = userEvent.setup();
    let resolveUpload: (result: UploadOverviewImageResult) => void = () => undefined;
    let resolveRecognition: (result: RecognitionResult) => void = () => undefined;
    const client = makeClient({
      uploadOverviewImage: vi.fn(
        () =>
          new Promise<UploadOverviewImageResult>((resolve) => {
            resolveUpload = resolve;
          }),
      ),
      recognizeIngredients: vi.fn(
        () =>
          new Promise<RecognitionResult>((resolve) => {
            resolveRecognition = resolve;
          }),
      ),
    });
    const onRecognized = vi.fn();
    render(
      <CameraScreen
        sessionId={sessionId}
        expectedVersion={1}
        client={client}
        onRecognized={onRecognized}
      />,
    );

    await user.upload(
      screen.getByLabelText("选择桌面照片"),
      new File(["first"], "桌面.jpg", { type: "image/jpeg" }),
    );
    const submit = screen.getByRole("button", { name: "上传照片并识别" });
    await user.click(submit);

    expect(screen.getByText("正在上传照片…")).toBeInTheDocument();
    expect(submit).toBeDisabled();

    resolveUpload(uploadResult);
    expect(await screen.findByText("正在识别材料…")).toBeInTheDocument();
    resolveRecognition(recognitionResult);
    expect(await screen.findByText("识别完成，等待确认")).toBeInTheDocument();
    expect(onRecognized).toHaveBeenCalledWith({
      ingredients: recognitionResult.recognition.ingredients,
      overviewImageId: uploadResult.image.id,
      session: recognitionResult.session,
    });
  });

  it("keeps the preview and shows an accessible error when upload fails", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      uploadOverviewImage: vi.fn().mockRejectedValue(new Error("图片上传失败，请重试")),
    });
    render(
      <CameraScreen
        sessionId={sessionId}
        expectedVersion={1}
        client={client}
        onRecognized={vi.fn()}
      />,
    );

    await user.upload(
      screen.getByLabelText("选择桌面照片"),
      new File(["first"], "桌面.jpg", { type: "image/jpeg" }),
    );
    await user.click(screen.getByRole("button", { name: "上传照片并识别" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("图片上传失败，请重试");
    expect(screen.getByRole("img", { name: "桌面材料预览" })).toBeInTheDocument();
    expect(screen.getByText("桌面.jpg")).toBeInTheDocument();
  });

  it("retries recognition from the uploaded image without uploading again", async () => {
    const user = userEvent.setup();
    const uploadOverviewImage = vi.fn().mockResolvedValue(uploadResult);
    const recognizeIngredients = vi
      .fn<SessionClientLike["recognizeIngredients"]>()
      .mockRejectedValueOnce(new Error("识别服务暂时不可用"))
      .mockResolvedValueOnce(recognitionResult);
    const client = makeClient({ uploadOverviewImage, recognizeIngredients });
    render(
      <CameraScreen
        sessionId={sessionId}
        expectedVersion={1}
        client={client}
        onRecognized={vi.fn()}
      />,
    );

    await user.upload(
      screen.getByLabelText("选择桌面照片"),
      new File(["first"], "桌面.jpg", { type: "image/jpeg" }),
    );
    await user.click(screen.getByRole("button", { name: "上传照片并识别" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("识别服务暂时不可用");

    await user.click(screen.getByRole("button", { name: "上传照片并识别" }));
    expect(await screen.findByText("识别完成，等待确认")).toBeInTheDocument();
    expect(uploadOverviewImage).toHaveBeenCalledTimes(1);
    expect(recognizeIngredients).toHaveBeenCalledTimes(2);
    expect(recognizeIngredients).toHaveBeenNthCalledWith(2, {
      sessionId,
      expectedVersion: uploadResult.session.version,
      overviewImageId: uploadResult.image.id,
      labelImageIds: [],
    });
  });
});
