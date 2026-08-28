// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IngredientConfirmationScreen } from "@/components/ingredients/ingredient-confirmation-screen";
import type { DetectedIngredient } from "@/src/domain/ingredient";
import type { SessionClientLike } from "@/src/infrastructure/http/session-client";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";

const mixer: DetectedIngredient = {
  rawName: "苏打水",
  canonicalName: "苏打水",
  category: "mixer",
  brand: null,
  abv: 0,
  confidence: 0.98,
  confirmed: true,
};

const spiritWithoutAbv: DetectedIngredient = {
  rawName: "二锅头",
  canonicalName: "白酒",
  category: "spirit",
  brand: null,
  abv: null,
  confidence: 0.72,
  confirmed: false,
};

const unknownIngredient: DetectedIngredient = {
  rawName: "一小瓶不明液体",
  canonicalName: "一小瓶不明液体",
  category: "unknown",
  brand: null,
  abv: null,
  confidence: 0.51,
  confirmed: false,
};

function makeClient(overrides: Partial<SessionClientLike> = {}): SessionClientLike {
  return {
    getSession: vi.fn(),
    savePreferences: vi.fn(),
    uploadOverviewImage: vi.fn(),
    recognizeIngredients: vi.fn(),
    confirmIngredients: vi.fn().mockResolvedValue({
      ingredients: [mixer],
      session: { id: sessionId, state: "READY", version: 4 },
    }),
    ...overrides,
  } as SessionClientLike;
}

describe("IngredientConfirmationScreen", () => {
  afterEach(() => cleanup());

  it("lets the user add, edit, categorize, and remove material rows", async () => {
    const user = userEvent.setup();
    render(
      <IngredientConfirmationScreen
        sessionId={sessionId}
        expectedVersion={3}
        initialIngredients={[mixer]}
        client={makeClient()}
        onConfirmed={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "添加材料" }));
    expect(screen.getByLabelText("材料 2 名称")).toHaveValue("新材料");

    await user.clear(screen.getByLabelText("材料 2 名称"));
    await user.type(screen.getByLabelText("材料 2 名称"), "柠檬");
    await user.selectOptions(screen.getByLabelText("材料 2 类别"), "fruit");
    expect(screen.getByLabelText("材料 2 名称")).toHaveValue("柠檬");
    expect(screen.getByLabelText("材料 2 类别")).toHaveValue("fruit");

    await user.click(screen.getByRole("button", { name: "删除材料 2" }));
    expect(screen.queryByLabelText("材料 2 名称")).not.toBeInTheDocument();
  });

  it("blocks continuation for unconfirmed material and explains the reason", () => {
    render(
      <IngredientConfirmationScreen
        sessionId={sessionId}
        expectedVersion={3}
        initialIngredients={[spiritWithoutAbv]}
        client={makeClient()}
        onConfirmed={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "确认材料并继续" })).toBeDisabled();
    expect(screen.getByText("请先确认所有材料，再继续。")).toBeInTheDocument();
  });

  it("blocks unknown category and shows a separate category explanation", async () => {
    const user = userEvent.setup();
    render(
      <IngredientConfirmationScreen
        sessionId={sessionId}
        expectedVersion={3}
        initialIngredients={[unknownIngredient]}
        client={makeClient()}
        onConfirmed={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "确认材料并继续" })).toBeDisabled();
    expect(screen.getByText("请先把 unknown 材料改成受控类别。")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("材料 1 类别"), "fruit");
    await user.click(screen.getByLabelText("材料 1 已确认"));
    expect(screen.getByRole("button", { name: "确认材料并继续" })).not.toBeDisabled();
  });

  it("requires ABV for a confirmed spirit while keeping confidence non-blocking and editable", async () => {
    const user = userEvent.setup();
    const editableSpirit = { ...spiritWithoutAbv, confirmed: true };
    render(
      <IngredientConfirmationScreen
        sessionId={sessionId}
        expectedVersion={3}
        initialIngredients={[editableSpirit]}
        client={makeClient()}
        onConfirmed={vi.fn()}
      />,
    );

    expect(screen.getByText("识别置信度 72%，请人工核对")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认材料并继续" })).toBeDisabled();
    expect(screen.getByText("酒类必须先填写并确认 ABV。")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("材料 1 名称"));
    await user.type(screen.getByLabelText("材料 1 名称"), "高粱白酒");
    await user.clear(screen.getByLabelText("材料 1 酒精度（ABV）"));
    await user.type(screen.getByLabelText("材料 1 酒精度（ABV）"), "42");
    expect(screen.getByLabelText("材料 1 名称")).toHaveValue("高粱白酒");
    expect(screen.getByLabelText("材料 1 酒精度（ABV）")).toHaveValue(42);
    expect(screen.getByRole("button", { name: "确认材料并继续" })).not.toBeDisabled();
  });

  it("sends the edited ingredients and advances using the server response", async () => {
    const user = userEvent.setup();
    const onConfirmed = vi.fn();
    const client = makeClient();
    render(
      <IngredientConfirmationScreen
        sessionId={sessionId}
        expectedVersion={3}
        initialIngredients={[mixer]}
        client={client}
        onConfirmed={onConfirmed}
      />,
    );

    await user.click(screen.getByRole("button", { name: "确认材料并继续" }));

    expect(client.confirmIngredients).toHaveBeenCalledWith({
      sessionId,
      expectedVersion: 3,
      ingredients: [mixer],
    });
    expect(onConfirmed).toHaveBeenCalledWith({
      ingredients: [mixer],
      session: { id: sessionId, state: "READY", version: 4 },
    });
  });

  it("keeps edits and exposes an accessible error when confirmation fails", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      confirmIngredients: vi.fn().mockRejectedValue(new Error("请重新加载会话")),
    });
    render(
      <IngredientConfirmationScreen
        sessionId={sessionId}
        expectedVersion={3}
        initialIngredients={[mixer]}
        client={client}
        onConfirmed={vi.fn()}
      />,
    );

    await user.clear(screen.getByLabelText("材料 1 名称"));
    await user.type(screen.getByLabelText("材料 1 名称"), "苏打水（已核对）");
    await user.click(screen.getByRole("button", { name: "确认材料并继续" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请重新加载会话");
    expect(screen.getByLabelText("材料 1 名称")).toHaveValue("苏打水（已核对）");
  });
});
