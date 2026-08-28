// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FixedActionBar } from "@/components/session/fixed-action-bar";
import { ProgressHeader } from "@/components/session/progress-header";
import { SessionShell } from "@/components/session/session-shell";
import type { SessionClientLike, SessionSnapshot } from "@/src/infrastructure/http/session-client";

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

function makeClient(overrides: Partial<SessionClientLike> = {}): SessionClientLike {
  return {
    getSession: vi.fn().mockResolvedValue(preferencesSnapshot),
    getRecipeSet: vi.fn(),
    savePreferences: vi.fn(),
    uploadOverviewImage: vi.fn(),
    recognizeIngredients: vi.fn(),
    confirmIngredients: vi.fn(),
    generateRecipeSet: vi.fn(),
    selectRecipe: vi.fn(),
    advanceMixing: vi.fn(),
    uploadMixingStepImage: vi.fn(),
    ...overrides,
  };
}

describe("mobile shell", () => {
  afterEach(() => cleanup());

  it("names the main landmark and exposes busy semantics while restoring a session", () => {
    const getSession = vi.fn(() => new Promise<SessionSnapshot>(() => undefined));

    render(
      <SessionShell
        sessionId={preferencesSnapshot.session.id}
        client={makeClient({ getSession })}
      />,
    );

    const main = screen.getByRole("main", { name: "调饮实验" });
    expect(main).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("正在恢复会话");
  });

  it("keeps initial loading failures visible with an explicit session recovery action", async () => {
    const client = makeClient({
      getSession: vi.fn().mockRejectedValue(new Error("会话暂时不可用")),
    });

    render(<SessionShell sessionId={preferencesSnapshot.session.id} client={client} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("会话暂时不可用");
    expect(screen.getByRole("button", { name: "重新加载会话" })).toBeInTheDocument();
  });

  it("announces the current workflow step in the progress header", () => {
    render(<ProgressHeader state="SCAN" />);

    expect(screen.getByRole("banner", { name: "调饮实验进度" })).toBeInTheDocument();
    expect(screen.getByText("第 2 步")).toBeInTheDocument();
    expect(screen.getByText(/共 9 步/)).toBeInTheDocument();
  });

  it("separates fixed actions into a labeled current-action region", () => {
    render(
      <FixedActionBar>
        <button type="button">继续</button>
      </FixedActionBar>,
    );

    expect(screen.getByRole("region", { name: "当前操作" })).toContainElement(
      screen.getByRole("button", { name: "继续" }),
    );
  });
});
