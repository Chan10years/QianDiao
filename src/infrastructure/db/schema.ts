import { sql } from "drizzle-orm";
import {
  AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sessionStates = [
  "PREFERENCES",
  "SCAN",
  "CONFIRM",
  "READY",
  "RECIPE_SELECTION",
  "MIXING",
  "FEEDBACK",
  "ADJUSTMENT",
  "COMPLETED",
] as const;

export const imageRoles = ["overview", "label_closeup", "final_drink", "mixing_step"] as const;
export const ingredientCategories = [
  "spirit",
  "mixer",
  "tea",
  "fruit",
  "sweetener",
  "herb",
  "ice",
  "energy_drink",
  "medicine",
  "non_food",
  "unknown",
] as const;
export const recipeStrategies = ["A_CONSERVATIVE", "B_CREATIVE", "C_UPGRADE"] as const;
export const safetyLevels = ["ALLOW", "WARN", "BLOCK"] as const;
export const recipeSourceModes = ["fallback", "qwen"] as const;

const stateSql = sql.raw(sessionStates.map((state) => `'${state}'`).join(", "));
const roleSql = sql.raw(imageRoles.map((role) => `'${role}'`).join(", "));
const categorySql = sql.raw(ingredientCategories.map((category) => `'${category}'`).join(", "));
const strategySql = sql.raw(recipeStrategies.map((strategy) => `'${strategy}'`).join(", "));
const safetySql = sql.raw(safetyLevels.map((level) => `'${level}'`).join(", "));
const sourceModeSql = sql.raw(recipeSourceModes.map((mode) => `'${mode}'`).join(", "));

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    state: text("state", { enum: sessionStates }).notNull().default("PREFERENCES"),
    version: integer("version").notNull().default(0),
    preferencesJson: text("preferences_json"),
    selectedRecipeId: text("selected_recipe_id").references((): AnySQLiteColumn => recipes.id, {
      onDelete: "set null",
    }),
    currentStep: integer("current_step"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    check("sessions_state_check", sql`${table.state} IN (${stateSql})`),
    check("sessions_version_check", sql`${table.version} >= 0`),
    check(
      "sessions_current_step_check",
      sql`${table.currentStep} IS NULL OR ${table.currentStep} >= 0`,
    ),
    index("sessions_state_idx").on(table.state),
  ],
);

export const sessionMutationLeases = sqliteTable(
  "session_mutation_leases",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    leaseOwner: text("lease_owner").notNull(),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("session_mutation_leases_request_unique").on(table.requestId),
    index("session_mutation_leases_expiry_idx").on(table.leaseExpiresAt),
    check("session_mutation_leases_version_check", sql`${table.expectedVersion} >= 0`),
  ],
);

export const images = sqliteTable(
  "images",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: imageRoles }).notNull(),
    recipeId: text("recipe_id").references((): AnySQLiteColumn => recipes.id, {
      onDelete: "cascade",
    }),
    stepIndex: integer("step_index"),
    objectKey: text("object_key").notNull(),
    mime: text("mime").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("images_object_key_unique").on(table.objectKey),
    uniqueIndex("images_mixing_current_unique").on(
      table.sessionId,
      table.recipeId,
      table.stepIndex,
    ),
    index("images_session_idx").on(table.sessionId),
    index("images_mixing_lookup_idx").on(table.sessionId, table.recipeId, table.stepIndex),
    check("images_dimensions_check", sql`${table.width} > 0 AND ${table.height} > 0`),
    check("images_role_check", sql`${table.role} IN (${roleSql})`),
    check(
      "images_mixing_link_check",
      sql`(${table.role} = 'mixing_step' AND ${table.recipeId} IS NOT NULL AND ${table.stepIndex} IS NOT NULL AND ${table.stepIndex} >= 0) OR (${table.role} <> 'mixing_step' AND ${table.recipeId} IS NULL AND ${table.stepIndex} IS NULL)`,
    ),
  ],
);

export const ingredients = sqliteTable(
  "ingredients",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: "cascade" }),
    rawName: text("raw_name").notNull(),
    canonicalName: text("canonical_name").notNull(),
    category: text("category", { enum: ingredientCategories }).notNull(),
    brand: text("brand"),
    abv: real("abv"),
    confidence: real("confidence").notNull(),
    confirmed: integer("confirmed", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("ingredients_session_canonical_unique").on(table.sessionId, table.canonicalName),
    index("ingredients_session_idx").on(table.sessionId),
    index("ingredients_confirmation_idx").on(table.sessionId, table.confirmed),
    check(
      "ingredients_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "ingredients_abv_check",
      sql`${table.abv} IS NULL OR (${table.abv} >= 0 AND ${table.abv} <= 100)`,
    ),
    check("ingredients_category_check", sql`${table.category} IN (${categorySql})`),
  ],
);

export const recipeSets = sqliteTable(
  "recipe_sets",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: "cascade" }),
    recommendedRecipeId: text("recommended_recipe_id").references(
      (): AnySQLiteColumn => recipes.id,
      { onDelete: "set null" },
    ),
    sourceMode: text("source_mode", { enum: recipeSourceModes }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("recipe_sets_session_idx").on(table.sessionId, table.createdAt),
    check("recipe_sets_source_mode_check", sql`${table.sourceMode} IN (${sourceModeSql})`),
  ],
);

export const recipes = sqliteTable(
  "recipes",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: "cascade" }),
    recipeSetId: text("recipe_set_id")
      .notNull()
      .references((): AnySQLiteColumn => recipeSets.id, { onDelete: "cascade" }),
    strategy: text("strategy", { enum: recipeStrategies }).notNull(),
    title: text("title").notNull(),
    fitReason: text("fit_reason").notNull(),
    differenceReason: text("difference_reason").notNull(),
    materialsJson: text("materials_json").notNull(),
    stepsJson: text("steps_json").notNull(),
    estimatedAbv: real("estimated_abv"),
    safetyLevel: text("safety_level", { enum: safetyLevels }).notNull(),
    experimental: integer("experimental", { mode: "boolean" }).notNull(),
    missingIngredientsJson: text("missing_ingredients_json").notNull(),
    version: integer("version").notNull().default(1),
    parentRecipeId: text("parent_recipe_id").references((): AnySQLiteColumn => recipes.id, {
      onDelete: "set null",
    }),
    feedbackId: text("feedback_id").references((): AnySQLiteColumn => feedback.id, {
      onDelete: "no action",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("recipes_set_strategy_unique").on(table.recipeSetId, table.strategy),
    index("recipes_session_idx").on(table.sessionId),
    index("recipes_set_idx").on(table.recipeSetId),
    index("recipes_parent_idx").on(table.parentRecipeId),
    index("recipes_feedback_idx").on(table.feedbackId),
    check("recipes_strategy_check", sql`${table.strategy} IN (${strategySql})`),
    check("recipes_safety_level_check", sql`${table.safetyLevel} IN (${safetySql})`),
    check("recipes_version_check", sql`${table.version} > 0`),
  ],
);

export const safetyDecisions = sqliteTable(
  "safety_decisions",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id")
      .notNull()
      .references((): AnySQLiteColumn => recipes.id, { onDelete: "cascade" }),
    level: text("level", { enum: safetyLevels }).notNull(),
    ruleHitsJson: text("rule_hits_json").notNull(),
    engineVersion: text("engine_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("safety_decisions_recipe_unique").on(table.recipeId),
    index("safety_decisions_level_idx").on(table.level),
    check("safety_decisions_level_check", sql`${table.level} IN (${safetySql})`),
  ],
);

export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: "cascade" }),
    recipeId: text("recipe_id")
      .notNull()
      .references((): AnySQLiteColumn => recipes.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    accepted: integer("accepted", { mode: "boolean" }).notNull(),
    deltasJson: text("deltas_json").notNull(),
    notes: text("notes"),
    finalImageId: text("final_image_id").references((): AnySQLiteColumn => images.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("feedback_session_idx").on(table.sessionId, table.createdAt),
    index("feedback_recipe_idx").on(table.recipeId),
    check("feedback_rating_check", sql`${table.rating} BETWEEN 1 AND 5`),
  ],
);

export const decisionEvents = sqliteTable(
  "decision_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    summary: text("summary").notNull(),
    metadataJson: text("metadata_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index("decision_events_session_idx").on(table.sessionId, table.createdAt)],
);

export const experimentMemories = sqliteTable(
  "experiment_memories",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id")
      .notNull()
      .references((): AnySQLiteColumn => recipes.id, { onDelete: "cascade" }),
    feedbackId: text("feedback_id")
      .notNull()
      .references((): AnySQLiteColumn => feedback.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    tagsJson: text("tags_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("experiment_memories_recipe_idx").on(table.recipeId),
    index("experiment_memories_feedback_idx").on(table.feedbackId),
  ],
);

export const idempotencyRecords = sqliteTable(
  "idempotency_records",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    responseJson: text("response_json").notNull(),
    statusCode: integer("status_code").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("idempotency_records_request_unique").on(table.requestId),
    index("idempotency_records_session_idx").on(table.sessionId),
    check(
      "idempotency_records_lease_pair_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check("idempotency_records_status_check", sql`${table.statusCode} BETWEEN 100 AND 599`),
  ],
);

export const fallbackMaterials = sqliteTable(
  "fallback_materials",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category", { enum: ingredientCategories }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("fallback_materials_name_unique").on(table.name),
    check("fallback_materials_category_check", sql`${table.category} IN (${categorySql})`),
  ],
);

export const inspirations = sqliteTable(
  "inspirations",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url").notNull(),
    summary: text("summary").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [uniqueIndex("inspirations_source_url_unique").on(table.sourceUrl)],
);

export const recipeTemplates = sqliteTable(
  "recipe_templates",
  {
    id: text("id").primaryKey(),
    strategy: text("strategy", { enum: recipeStrategies }).notNull(),
    title: text("title").notNull(),
    fitReason: text("fit_reason").notNull(),
    differenceReason: text("difference_reason").notNull(),
    materialsJson: text("materials_json").notNull(),
    stepsJson: text("steps_json").notNull(),
    estimatedAbv: real("estimated_abv"),
    experimental: integer("experimental", { mode: "boolean" }).notNull(),
    missingIngredientsJson: text("missing_ingredients_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("recipe_templates_strategy_unique").on(table.strategy),
    check("recipe_templates_strategy_check", sql`${table.strategy} IN (${strategySql})`),
  ],
);
export const schema = {
  sessions,
  images,
  ingredients,
  recipeSets,
  recipes,
  safetyDecisions,
  feedback,
  decisionEvents,
  experimentMemories,
  sessionMutationLeases,
  idempotencyRecords,
  fallbackMaterials,
  inspirations,
  recipeTemplates,
};
