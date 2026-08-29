// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Home from "@/app/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("Home", () => {
  afterEach(() => {
    cleanup();
  });

  it("introduces the QianDiao flavor experiment before its existing start action", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { name: "黔调中调你的调" })).toBeVisible();
    expect(screen.getByText("贵州白酒 · 个性化调饮实验")).toBeVisible();
    expect(screen.getByText("山有层 · 酒有香 · 人有偏好")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始我的风味实验" })).toBeVisible();
    expect(screen.getByText("未成年人和患相关疾病者禁止饮酒。")).toBeVisible();
  });
});
