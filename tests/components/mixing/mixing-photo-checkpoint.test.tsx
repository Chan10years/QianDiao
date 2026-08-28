// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MixingScreen } from "@/components/mixing/mixing-screen";
import { RecipeDisplaySchema } from "@/src/domain/recipe";
import type { SessionClientLike } from "@/src/infrastructure/http/session-client";
import { makeDomainFixtures } from "@/tests/fixtures/domain";

function makeClient(): SessionClientLike {
  return {
    getSession: vi.fn(),
    getRecipeSet: vi.fn(),
    savePreferences: vi.fn(),
    uploadOverviewImage: vi.fn(),
    recognizeIngredients: vi.fn(),
    confirmIngredients: vi.fn(),
    generateRecipeSet: vi.fn(),
    selectRecipe: vi.fn(),
    advanceMixing: vi.fn(),
    uploadMixingStepImage: vi.fn(),
  };
}

function makeRecipe(isPhotoCheckpoint: boolean) {
  const fixtures = makeDomainFixtures();
  return RecipeDisplaySchema.parse({
    ...fixtures.recipes[0],
    steps: [{ order: 1, instruction: "加入冰块并降温。", isPhotoCheckpoint }],
    safety: { level: "ALLOW", reasons: [], alternatives: [] },
  });
}

describe("mixing photo checkpoint", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens the photo-first panel with the camera input contract", () => {
    render(
      <MixingScreen
        sessionId="11111111-1111-4111-8111-111111111111"
        expectedVersion={1}
        currentStep={0}
        recipe={makeRecipe(true)}
        client={makeClient()}
        onAdvanced={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "拍照专页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拍摄关键步骤" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂时跳过" })).toBeInTheDocument();
    expect(screen.getByLabelText("拍摄关键步骤照片")).toHaveAttribute(
      "accept",
      "image/jpeg,image/png,image/webp",
    );
    expect(screen.getByLabelText("拍摄关键步骤照片")).toHaveAttribute("capture", "environment");
  });

  it("does not show photo UI for a normal step", () => {
    render(
      <MixingScreen
        sessionId="11111111-1111-4111-8111-111111111111"
        expectedVersion={1}
        currentStep={0}
        recipe={makeRecipe(false)}
        client={makeClient()}
        onAdvanced={vi.fn()}
      />,
    );

    expect(screen.queryByRole("heading", { name: "拍照专页" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拍摄关键步骤" })).not.toBeInTheDocument();
  });

  it("skips the panel without upload or advance and then allows the normal step action", async () => {
    const client = makeClient();
    const user = userEvent.setup();
    render(
      <MixingScreen
        sessionId="11111111-1111-4111-8111-111111111111"
        expectedVersion={1}
        currentStep={0}
        recipe={makeRecipe(true)}
        client={client}
        onAdvanced={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "暂时跳过" }));
    expect(screen.queryByRole("heading", { name: "拍照专页" })).not.toBeInTheDocument();
    expect(client.uploadOverviewImage).not.toHaveBeenCalled();
    expect(client.advanceMixing).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "完成最后一步" })).toBeEnabled();
  });

  it("keeps the local preview after an upload error and retries the same file", async () => {
    const user = userEvent.setup();
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:checkpoint");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const client = makeClient();
    const uploadMixingStepImage = vi
      .fn<SessionClientLike["uploadMixingStepImage"]>()
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockResolvedValueOnce({
        image: {
          id: "223e4567-e89b-12d3-a456-426614174000",
          role: "mixing_step",
          mime: "image/jpeg",
          width: 8,
          height: 6,
        },
        session: {
          id: "11111111-1111-4111-8111-111111111111",
          state: "MIXING",
          version: 2,
        },
      });
    client.uploadMixingStepImage = uploadMixingStepImage;

    render(
      <MixingScreen
        sessionId="11111111-1111-4111-8111-111111111111"
        expectedVersion={1}
        currentStep={0}
        recipe={makeRecipe(true)}
        client={client}
        onAdvanced={vi.fn()}
        onPhotoUploaded={vi.fn()}
      />,
    );

    const file = new File(["jpeg"], "checkpoint.jpg", { type: "image/jpeg" });
    await user.upload(screen.getByLabelText("拍摄关键步骤照片"), file);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("照片上传失败"));
    expect(screen.getByAltText("关键步骤照片本地预览")).toHaveAttribute("src", "blob:checkpoint");
    expect(uploadMixingStepImage).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:checkpoint");

    await user.click(screen.getByRole("button", { name: "重试上传" }));
    await waitFor(() => expect(uploadMixingStepImage).toHaveBeenCalledTimes(2));
    expect(uploadMixingStepImage.mock.calls[1]?.[0].file).toBe(file);
    expect(createObjectUrl).toHaveBeenCalledWith(file);
    await waitFor(() => expect(revokeObjectUrl).toHaveBeenCalledWith("blob:checkpoint"));
  });

  it("restores a persisted photo and exposes replacement without reopening the initial prompt", async () => {
    const user = userEvent.setup();
    const recipe = makeRecipe(true);
    render(
      <MixingScreen
        sessionId="11111111-1111-4111-8111-111111111111"
        expectedVersion={2}
        currentStep={0}
        recipe={recipe}
        mixingPhoto={{
          imageId: "223e4567-e89b-12d3-a456-426614174000",
          role: "mixing_step",
          recipeId: recipe.id,
          stepIndex: 0,
          mime: "image/jpeg",
          width: 8,
          height: 6,
        }}
        client={makeClient()}
        onAdvanced={vi.fn()}
      />,
    );

    expect(screen.queryByRole("heading", { name: "拍照专页" })).not.toBeInTheDocument();
    expect(screen.getByAltText("已保存的关键步骤照片")).toHaveAttribute(
      "src",
      "/api/sessions/11111111-1111-4111-8111-111111111111/images/223e4567-e89b-12d3-a456-426614174000?v=2",
    );
    await user.click(screen.getByRole("button", { name: "替换照片" }));
    expect(screen.getByRole("heading", { name: "拍照专页" })).toBeInTheDocument();
  });

  it("changes the persisted photo URL to the committed session version after replacement", async () => {
    const user = userEvent.setup();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:replacement");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const recipe = makeRecipe(true);
    const imageId = "223e4567-e89b-12d3-a456-426614174000";
    const uploadMixingStepImage = vi.fn().mockResolvedValue({
      image: {
        id: imageId,
        role: "mixing_step",
        mime: "image/jpeg",
        width: 16,
        height: 12,
      },
      session: {
        id: "11111111-1111-4111-8111-111111111111",
        state: "MIXING",
        version: 3,
      },
    });
    const client = makeClient();
    client.uploadMixingStepImage = uploadMixingStepImage;

    function Harness() {
      const [expectedVersion, setExpectedVersion] = useState(2);
      return (
        <MixingScreen
          sessionId="11111111-1111-4111-8111-111111111111"
          expectedVersion={expectedVersion}
          currentStep={0}
          recipe={recipe}
          mixingPhoto={{
            imageId,
            role: "mixing_step",
            recipeId: recipe.id,
            stepIndex: 0,
            mime: "image/jpeg",
            width: 8,
            height: 6,
          }}
          client={client}
          onAdvanced={vi.fn()}
          onPhotoUploaded={(result) => setExpectedVersion(result.session.version)}
        />
      );
    }

    render(<Harness />);

    const persistedPhoto = screen.getByAltText("已保存的关键步骤照片");
    expect(persistedPhoto).toHaveAttribute(
      "src",
      `/api/sessions/11111111-1111-4111-8111-111111111111/images/${imageId}?v=2`,
    );

    await user.click(screen.getByRole("button", { name: "替换照片" }));
    await user.upload(
      screen.getByLabelText("拍摄关键步骤照片"),
      new File(["new-jpeg"], "replacement.jpg", { type: "image/jpeg" }),
    );

    await waitFor(() =>
      expect(screen.getByAltText("已保存的关键步骤照片")).toHaveAttribute(
        "src",
        `/api/sessions/11111111-1111-4111-8111-111111111111/images/${imageId}?v=3`,
      ),
    );
    expect(uploadMixingStepImage).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 2 }),
    );
  });
});
