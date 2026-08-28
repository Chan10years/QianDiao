// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreferencesScreen } from "@/components/preferences/preferences-screen";
import type { SessionSnapshot } from "@/src/infrastructure/http/session-client";

const scanSnapshot: SessionSnapshot = {
  data: {
    preferences: {
      sweetness: 4,
      acidity: 2,
      alcoholIntensity: 3,
      body: 2,
    },
    selectedRecipeId: null,
    currentStep: null,
    ingredients: [],
    mixingPhotos: [],
  },
  session: {
    id: "123e4567-e89b-12d3-a456-426614174000",
    state: "SCAN",
    version: 1,
  },
};

const initialPreferences = {
  sweetness: 3 as const,
  acidity: 3 as const,
  alcoholIntensity: 2 as const,
  body: 3 as const,
};

describe("PreferencesScreen", () => {
  afterEach(() => cleanup());

  it("prevents duplicate preference submissions while the request is loading", async () => {
    const user = userEvent.setup();
    let resolveSubmit: (snapshot: SessionSnapshot) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<SessionSnapshot>((resolve) => {
          resolveSubmit = resolve;
        }),
    );

    render(
      <PreferencesScreen
        initialPreferences={initialPreferences}
        expectedVersion={0}
        onSubmit={onSubmit}
      />,
    );

    const submit = screen.getByRole("button", { name: "保存口味，开始拍照" });
    await user.click(submit);
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();

    resolveSubmit(scanSnapshot);
  });

  it("keeps the edited values and exposes an accessible error when saving fails", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("网络暂时不可用"));

    render(
      <PreferencesScreen
        initialPreferences={initialPreferences}
        expectedVersion={0}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByRole("slider", { name: "甜度" }), { target: { value: "5" } });
    await user.click(screen.getByRole("button", { name: "保存口味，开始拍照" }));

    expect(screen.getByRole("slider", { name: "甜度" })).toHaveValue("5");
    expect(screen.getByRole("alert")).toHaveTextContent("网络暂时不可用");
    expect(screen.getByRole("button", { name: "保存口味，开始拍照" })).not.toBeDisabled();
  });

  it("passes the server snapshot to the shell after a successful save", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(scanSnapshot);
    const onSaved = vi.fn();

    render(
      <PreferencesScreen
        initialPreferences={initialPreferences}
        expectedVersion={0}
        onSubmit={onSubmit}
        onSaved={onSaved}
      />,
    );

    await user.click(screen.getByRole("button", { name: "保存口味，开始拍照" }));

    expect(onSaved).toHaveBeenCalledWith(scanSnapshot);
  });
});
