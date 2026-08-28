import { describe, expect, it } from "vitest";

import { seedDatabase } from "@/scripts/db-seed";
import { fallbackMaterials, inspirations, recipeTemplates } from "@/src/infrastructure/db/schema";
import { createTestDatabase } from "@/tests/helpers/test-database";

describe("fallback database seed", () => {
  it("persists fallback materials, inspirations, and recipe templates idempotently", () => {
    const database = createTestDatabase();

    try {
      seedDatabase(database.databasePath);
      seedDatabase(database.databasePath);

      const materials = database.db.select().from(fallbackMaterials).all();
      const inspirationRows = database.db.select().from(inspirations).all();
      const templateRows = database.db.select().from(recipeTemplates).all();

      expect(materials).toHaveLength(7);
      expect(materials.map((material) => material.name)).toEqual(
        expect.arrayContaining(["冰块", "冷泡茶", "柠檬", "苏打水", "薄荷", "蜂蜜", "白酒"]),
      );
      expect(inspirationRows).toHaveLength(1);
      expect(inspirationRows[0]?.sourceUrl).toBe("local://fallback/baijiu-soda");
      expect(templateRows).toHaveLength(3);
      expect(templateRows.map((template) => template.strategy)).toEqual(
        expect.arrayContaining(["A_CONSERVATIVE", "B_CREATIVE", "C_UPGRADE"]),
      );
    } finally {
      database.cleanup();
    }
  });
});
