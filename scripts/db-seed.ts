import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { IngredientCategorySchema } from "@/src/domain/ingredient";
import { RecipeCandidateSchema } from "@/src/domain/recipe";
import { createDatabase } from "@/src/infrastructure/db/client";
import { fallbackMaterials, inspirations, recipeTemplates } from "@/src/infrastructure/db/schema";
import { withTransaction } from "@/src/infrastructure/db/transaction";

const seedId = (suffix: string) => "00000000-0000-4000-8000-" + suffix.padStart(12, "0");

export const fallbackSeed = {
  ingredientCategories: ["spirit", "mixer", "tea", "fruit", "sweetener", "herb", "ice"],
  materials: [
    { id: seedId("1"), name: "白酒", category: "spirit" },
    { id: seedId("2"), name: "冰块", category: "ice" },
    { id: seedId("3"), name: "苏打水", category: "mixer" },
    { id: seedId("4"), name: "冷泡茶", category: "tea" },
    { id: seedId("5"), name: "柠檬", category: "fruit" },
    { id: seedId("6"), name: "蜂蜜", category: "sweetener" },
    { id: seedId("7"), name: "薄荷", category: "herb" },
  ],
  inspirations: [
    {
      id: seedId("101"),
      title: "清爽白酒苏打",
      sourceName: "本地 fallback 灵感库",
      sourceUrl: "local://fallback/baijiu-soda",
      summary: "以苏打水和冰块突出清爽口感。",
    },
  ],
  recipeTemplates: [
    {
      id: seedId("201"),
      strategy: "A_CONSERVATIVE",
      title: "保守清爽杯",
      fitReason: "用苏打水和冰块降低入口刺激，适合先尝试。",
      differenceReason: "三套方案中最清爽、材料最少。",
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 90, unit: "ml" },
        { name: "冰块", amountMl: 120, unit: "ml" },
      ],
      steps: [
        { order: 1, instruction: "杯中加入冰块。" },
        { order: 2, instruction: "倒入白酒和苏打水，轻轻搅拌。" },
      ],
      estimatedAbv: 10,
      safetyLevel: "ALLOW",
      experimental: false,
      missingIngredients: [],
    },
    {
      id: seedId("202"),
      strategy: "B_CREATIVE",
      title: "茶香创意杯",
      fitReason: "冷泡茶带来柔和茶香，保留白酒主体。",
      differenceReason: "相较保守方案增加茶香层次。",
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "冷泡茶", amountMl: 90, unit: "ml" },
        { name: "冰块", amountMl: 120, unit: "ml" },
      ],
      steps: [
        { order: 1, instruction: "杯中加入冰块。" },
        { order: 2, instruction: "倒入白酒和冷泡茶，轻轻搅拌。" },
      ],
      estimatedAbv: 10,
      safetyLevel: "ALLOW",
      experimental: false,
      missingIngredients: [],
    },
    {
      id: seedId("203"),
      strategy: "C_UPGRADE",
      title: "柑橘升级杯",
      fitReason: "柠檬香气和苏打水让风味更明亮。",
      differenceReason: "相较前两套方案增加柑橘香气。",
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "柠檬", amountMl: 10, unit: "ml" },
        { name: "苏打水", amountMl: 80, unit: "ml" },
        { name: "冰块", amountMl: 120, unit: "ml" },
      ],
      steps: [
        { order: 1, instruction: "杯中加入冰块和柠檬汁。" },
        { order: 2, instruction: "倒入白酒和苏打水，轻轻搅拌。" },
      ],
      estimatedAbv: 10,
      safetyLevel: "ALLOW",
      experimental: false,
      missingIngredients: [],
    },
  ],
} as const;

export function seedDatabase(databasePath: string): void {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = createDatabase(databasePath);

  try {
    database.applyMigrations();
    withTransaction(database.db, (transaction) => {
      transaction
        .insert(fallbackMaterials)
        .values(
          fallbackSeed.materials.map((material) => ({
            id: material.id,
            name: material.name,
            category: IngredientCategorySchema.parse(material.category),
          })),
        )
        .onConflictDoNothing()
        .run();

      transaction
        .insert(inspirations)
        .values(
          fallbackSeed.inspirations.map((inspiration) => ({
            id: inspiration.id,
            title: inspiration.title,
            sourceName: inspiration.sourceName,
            sourceUrl: inspiration.sourceUrl,
            summary: inspiration.summary,
          })),
        )
        .onConflictDoNothing()
        .run();

      const templateRows = fallbackSeed.recipeTemplates.map((template) => {
        const candidate = RecipeCandidateSchema.parse(template);
        return {
          id: candidate.id,
          strategy: candidate.strategy,
          title: candidate.title,
          fitReason: candidate.fitReason,
          differenceReason: candidate.differenceReason,
          materialsJson: JSON.stringify(candidate.materials),
          stepsJson: JSON.stringify(candidate.steps),
          estimatedAbv: candidate.estimatedAbv,
          experimental: candidate.experimental,
          missingIngredientsJson: JSON.stringify(candidate.missingIngredients),
        };
      });

      transaction.insert(recipeTemplates).values(templateRows).onConflictDoNothing().run();
    });
  } finally {
    database.close();
  }
}

const invokedScript = process.argv[1];
if (invokedScript !== undefined && import.meta.url === pathToFileURL(invokedScript).href) {
  const databasePath = path.resolve(process.env.DATABASE_PATH ?? "./data/app.db");
  seedDatabase(databasePath);
  console.log(
    "Fallback seed catalog ready: " + fallbackSeed.recipeTemplates.length + " recipe templates.",
  );
}
