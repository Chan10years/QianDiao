// @vitest-environment jsdom

import { useState } from "react";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { TasteSlider } from "@/components/preferences/taste-slider";

function TasteSliderHarness() {
  const [value, setValue] = useState<1 | 2 | 3 | 4 | 5>(3);

  return (
    <TasteSlider
      id="sweetness"
      label="甜度"
      value={value}
      onChange={setValue}
      minLabel="不甜"
      maxLabel="很甜"
    />
  );
}

describe("TasteSlider", () => {
  afterEach(() => cleanup());

  it("renders an accessible five-level range with its initial value and endpoint labels", () => {
    render(<TasteSliderHarness />);

    const slider = screen.getByRole("slider", { name: "甜度" });

    expect(slider).toHaveAttribute("type", "range");
    expect(slider).toHaveAttribute("min", "1");
    expect(slider).toHaveAttribute("max", "5");
    expect(slider).toHaveAttribute("step", "1");
    expect(slider).toHaveValue("3");
    expect(screen.getByText("不甜")).toBeInTheDocument();
    expect(screen.getByText("很甜")).toBeInTheDocument();
  });

  it("moves by one integer level with keyboard direction keys", async () => {
    const user = userEvent.setup();
    render(<TasteSliderHarness />);

    const slider = screen.getByRole("slider", { name: "甜度" });
    slider.focus();
    await user.keyboard("{ArrowRight}");
    expect(slider).toHaveValue("4");

    await user.keyboard("{ArrowLeft}");
    expect(slider).toHaveValue("3");
  });
});
