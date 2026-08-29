import { SafetyBadge } from "@/components/safety/safety-badge";
import { WarningConfirmation } from "@/components/safety/warning-confirmation";
import type { RecipeDisplay } from "@/src/domain/recipe";

const strategyLabel: Record<RecipeDisplay["strategy"], string> = {
  A_CONSERVATIVE: "A · 保守",
  B_CREATIVE: "B · 创意",
  C_UPGRADE: "C · 升级",
};

interface RecipeCardProps {
  recipe: RecipeDisplay;
  recommended: boolean;
  warningAcknowledged: boolean;
  onWarningChange: (checked: boolean) => void;
}

export function RecipeCard({
  recipe,
  recommended,
  warningAcknowledged,
  onWarningChange,
}: RecipeCardProps) {
  const isWarn = recipe.safety.level === "WARN";

  return (
    <article className="recipe-card">
      <header className="recipe-card__header">
        <div className="recipe-card__heading">
          <p className="recipe-card__eyebrow">{strategyLabel[recipe.strategy]}</p>
          <h2>{recipe.title}</h2>
        </div>
        {recommended ? <span className="recipe-card__recommendation">推荐方案</span> : null}
      </header>

      <p className="recipe-card__fit">{recipe.fitReason}</p>
      <p className="recipe-card__first-taste">
        <strong>第一口感</strong>
        <span>{recipe.differenceReason}</span>
      </p>

      <section className="recipe-card__recipe-line">
        <h3>配方与用量</h3>
        <ul>
          {recipe.materials.map((material) => (
            <li key={`${material.name}-${material.amountMl}`}>
              {material.name} · {material.amountMl} {material.unit}
            </li>
          ))}
        </ul>
      </section>

      <div className="recipe-card__tags" aria-label="配方特征">
        <span>
          预计 {recipe.estimatedAbv === null ? "ABV 待确认" : `${recipe.estimatedAbv}% ABV`}
        </span>
        <span>
          {recipe.missingIngredients.length > 0
            ? `缺少：${recipe.missingIngredients.join("、")}`
            : "材料齐备"}
        </span>
      </div>

      <section className="recipe-card__steps">
        <h3>调制步骤</h3>
        <ol>
          {recipe.steps.map((step) => (
            <li key={step.order}>{step.instruction}</li>
          ))}
        </ol>
      </section>

      <SafetyBadge safety={recipe.safety} />

      {isWarn ? (
        <WarningConfirmation
          recipeTitle={recipe.title}
          checked={warningAcknowledged}
          onChange={onWarningChange}
        />
      ) : null}
    </article>
  );
}
