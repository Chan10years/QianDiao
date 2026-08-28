import { describe, expect, it } from "vitest";

import {
  calculateAlcohol,
  calculateFinalAbv,
  calculatePureAlcoholMl,
} from "@/src/safety/calculate-alcohol";

describe("calculatePureAlcoholMl", () => {
  it.each([
    { volumeMl: 30, abv: 42, expected: 12.6 },
    { volumeMl: 100, abv: 5.5, expected: 5.5 },
    { volumeMl: 0, abv: 42, expected: 0 },
  ])("calculates pure alcohol from volume and ABV", ({ volumeMl, abv, expected }) => {
    expect(calculatePureAlcoholMl(volumeMl, abv)).toBeCloseTo(expected, 10);
  });

  it.each([
    { volumeMl: -1, abv: 42 },
    { volumeMl: 30, abv: null },
    { volumeMl: Number.NaN, abv: 42 },
    { volumeMl: 30, abv: 101 },
  ])("returns unavailable for invalid or unknown alcohol input", ({ volumeMl, abv }) => {
    expect(calculatePureAlcoholMl(volumeMl, abv)).toBeNull();
  });
});

describe("calculateFinalAbv", () => {
  it("calculates final ABV from total pure alcohol and total drink volume", () => {
    expect(calculateFinalAbv(12.6, 130)).toBeCloseTo(9.6923076923, 10);
  });

  it.each([
    { totalPureAlcoholMl: 12.6, totalDrinkMl: 0 },
    { totalPureAlcoholMl: 12.6, totalDrinkMl: -1 },
    { totalPureAlcoholMl: -1, totalDrinkMl: 130 },
    { totalPureAlcoholMl: null, totalDrinkMl: 130 },
  ])("returns unavailable for an empty or invalid cup", (input) => {
    expect(calculateFinalAbv(input.totalPureAlcoholMl, input.totalDrinkMl)).toBeNull();
  });
});

describe("calculateAlcohol", () => {
  it("returns total pure alcohol and final ABV for a complete drink", () => {
    expect(
      calculateAlcohol({
        portions: [{ volumeMl: 30, abv: 42 }],
        totalDrinkMl: 130,
      }),
    ).toEqual({
      pureAlcoholMl: 12.6,
      finalAbv: expect.closeTo(9.6923076923, 10),
      calculable: true,
    });
  });

  it("returns unavailable when a mixed drink contains a portion with unknown ABV", () => {
    expect(
      calculateAlcohol({
        portions: [
          { volumeMl: 30, abv: 42 },
          { volumeMl: 15, abv: null },
        ],
        totalDrinkMl: 45,
      }),
    ).toEqual({ pureAlcoholMl: null, finalAbv: null, calculable: false });
  });

  it("returns unavailable when any alcoholic portion has unknown ABV", () => {
    expect(
      calculateAlcohol({
        portions: [{ volumeMl: 30, abv: null }],
        totalDrinkMl: 130,
      }),
    ).toEqual({ pureAlcoholMl: null, finalAbv: null, calculable: false });
  });
});
