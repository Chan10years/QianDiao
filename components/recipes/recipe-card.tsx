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
  selected: boolean;
  warningAcknowledged: boolean;
  onSelect: () => void;
  onWarningChange: (checked: boolean) => void;
}

export function RecipeCard({
  recipe,
  recommended,
  selected,
  warningAcknowledged,
  onSelect,
  onWarningChange,
}: RecipeCardProps) {
  const isWarn = recipe.safety.level === "WARN";
  const canSelect = !isWarn || warningAcknowledged;

  return (
    <article
      className={`space-y-4 rounded-3xl bg-white p-5 shadow-sm ring-1 ${
        selected ? "ring-amber-500" : "ring-stone-200"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium tracking-wide text-amber-700">
            {strategyLabel[recipe.strategy]}
          </p>
          <h2 className="mt-1 text-xl font-semibold text-stone-900">{recipe.title}</h2>
        </div>
        {recommended ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
            推荐方案
          </span>
        ) : null}
      </div>

      <p className="text-sm leading-6 text-stone-600">{recipe.fitReason}</p>
      <p className="rounded-2xl bg-stone-50 p-3 text-sm leading-6 text-stone-700">
        为什么不同：{recipe.differenceReason}
      </p>

      <div>
        <h3 className="font-semibold text-stone-900">材料与用量</h3>
        <ul className="mt-2 space-y-1 text-sm text-stone-700">
          {recipe.materials.map((material) => (
            <li key={`${material.name}-${material.amountMl}`}>
              {material.name} · {material.amountMl} {material.unit}
            </li>
          ))}
        </ul>
      </div>

      <p className="text-sm font-medium text-stone-700">
        预计 ABV：{recipe.estimatedAbv === null ? "待确认" : `${recipe.estimatedAbv}%`}
      </p>

      <div>
        <h3 className="font-semibold text-stone-900">调制步骤</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-stone-700">
          {recipe.steps.map((step) => (
            <li key={step.order}>{step.instruction}</li>
          ))}
        </ol>
      </div>

      {recipe.missingIngredients.length > 0 ? (
        <p className="text-sm text-stone-700">缺失材料：{recipe.missingIngredients.join("、")}</p>
      ) : (
        <p className="text-sm text-stone-700">缺失材料：无</p>
      )}

      <SafetyBadge safety={recipe.safety} />

      {isWarn ? (
        <WarningConfirmation
          recipeTitle={recipe.title}
          checked={warningAcknowledged}
          onChange={onWarningChange}
        />
      ) : null}

      <label className="flex min-h-11 items-center gap-3 rounded-2xl border border-stone-200 px-4 py-3 text-sm font-semibold text-stone-900">
        <input
          className="size-5 accent-stone-900"
          type="radio"
          name="recipe-choice"
          value={recipe.id}
          checked={selected}
          disabled={!canSelect}
          aria-label={`选择 ${recipe.title}`}
          onChange={onSelect}
        />
        <span>{canSelect ? "选择这套方案" : "请先确认 WARN 提示"}</span>
      </label>
    </article>
  );
}
