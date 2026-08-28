export interface AlcoholPortion {
  volumeMl: number;
  abv: number | null;
}

export interface AlcoholCalculation {
  pureAlcoholMl: number | null;
  finalAbv: number | null;
  calculable: boolean;
}

function isValidVolume(volumeMl: number): boolean {
  return Number.isFinite(volumeMl) && volumeMl >= 0;
}

function isValidAbv(abv: number): boolean {
  return Number.isFinite(abv) && abv >= 0 && abv <= 100;
}

export function calculatePureAlcoholMl(volumeMl: number, abv: number | null): number | null {
  if (!isValidVolume(volumeMl) || abv === null || !isValidAbv(abv)) {
    return null;
  }

  return (volumeMl * abv) / 100;
}

export function calculateFinalAbv(
  totalPureAlcoholMl: number | null,
  totalDrinkMl: number,
): number | null {
  if (
    totalPureAlcoholMl === null ||
    !Number.isFinite(totalPureAlcoholMl) ||
    totalPureAlcoholMl < 0 ||
    !Number.isFinite(totalDrinkMl) ||
    totalDrinkMl <= 0
  ) {
    return null;
  }

  return (totalPureAlcoholMl / totalDrinkMl) * 100;
}

export function calculateAlcohol(input: {
  portions: readonly AlcoholPortion[];
  totalDrinkMl: number;
}): AlcoholCalculation {
  if (!Number.isFinite(input.totalDrinkMl) || input.totalDrinkMl <= 0) {
    return { pureAlcoholMl: null, finalAbv: null, calculable: false };
  }

  if (input.portions.some((portion) => portion.abv === null)) {
    return { pureAlcoholMl: null, finalAbv: null, calculable: false };
  }

  let pureAlcoholMl = 0;
  for (const portion of input.portions) {
    const portionPureAlcoholMl = calculatePureAlcoholMl(portion.volumeMl, portion.abv);
    if (portionPureAlcoholMl === null) {
      return { pureAlcoholMl: null, finalAbv: null, calculable: false };
    }

    pureAlcoholMl += portionPureAlcoholMl;
  }

  const finalAbv = calculateFinalAbv(pureAlcoholMl, input.totalDrinkMl);
  if (finalAbv === null) {
    return { pureAlcoholMl: null, finalAbv: null, calculable: false };
  }

  return { pureAlcoholMl, finalAbv, calculable: true };
}

export const calculatePureAlcohol = calculatePureAlcoholMl;
