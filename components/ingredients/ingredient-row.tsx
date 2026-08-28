"use client";

import type { DetectedIngredient, IngredientCategory } from "@/src/domain/ingredient";

const categoryOptions: readonly { value: IngredientCategory; label: string }[] = [
  { value: "spirit", label: "酒类" },
  { value: "mixer", label: "汽水/饮料" },
  { value: "tea", label: "茶" },
  { value: "fruit", label: "水果" },
  { value: "sweetener", label: "甜味材料" },
  { value: "herb", label: "香草" },
  { value: "ice", label: "冰" },
  { value: "energy_drink", label: "能量饮料" },
  { value: "medicine", label: "药物" },
  { value: "non_food", label: "非食品" },
  { value: "unknown", label: "unknown（待分类）" },
];

export interface IngredientRowProps {
  ingredient: DetectedIngredient;
  index: number;
  onChange: (ingredient: DetectedIngredient) => void;
  onDelete: () => void;
}

export function IngredientRow({ ingredient, index, onChange, onDelete }: IngredientRowProps) {
  const rowNumber = index + 1;
  const update = (patch: Partial<DetectedIngredient>) => onChange({ ...ingredient, ...patch });

  return (
    <article
      className={
        ingredient.confirmed ? "ingredient-card ingredient-card--confirmed" : "ingredient-card"
      }
    >
      <div className="ingredient-card__header">
        <div className="ingredient-card__title">
          <span className="ingredient-card__dot" aria-hidden="true" />
          <div>
            <h2>材料 {rowNumber}</h2>
            <p className="ingredient-card__meta">
              识别置信度 {Math.round(ingredient.confidence * 100)}%，请人工核对
            </p>
          </div>
        </div>
        <span className="ingredient-card__status">
          {ingredient.confirmed ? "已确认" : "待确认"}
        </span>
      </div>

      <div className="space-y-3">
        <label className="form-field">
          <span>材料名称</span>
          <input
            className="form-control"
            aria-label={`材料 ${rowNumber} 名称`}
            type="text"
            value={ingredient.canonicalName}
            onChange={(event) => update({ canonicalName: event.target.value })}
          />
        </label>

        <label className="form-field">
          <span>受控类别</span>
          <select
            className="form-control"
            aria-label={`材料 ${rowNumber} 类别`}
            value={ingredient.category}
            onChange={(event) => update({ category: event.target.value as IngredientCategory })}
          >
            {categoryOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="form-field">
          <span>品牌（可选）</span>
          <input
            className="form-control"
            aria-label={`材料 ${rowNumber} 品牌`}
            type="text"
            value={ingredient.brand ?? ""}
            onChange={(event) => update({ brand: event.target.value || null })}
          />
        </label>

        <label className="form-field">
          <span>酒精度（ABV）</span>
          <input
            className="form-control"
            aria-label={`材料 ${rowNumber} 酒精度（ABV）`}
            type="number"
            min={0}
            max={100}
            step="0.1"
            value={ingredient.abv ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              update({ abv: value === "" ? null : Number(value) });
            }}
          />
        </label>

        <label className="confirm-field">
          <input
            className="confirm-control"
            aria-label={`材料 ${rowNumber} 已确认`}
            type="checkbox"
            checked={ingredient.confirmed}
            onChange={(event) => update({ confirmed: event.target.checked })}
          />
          <span>我确认这项材料确实存在，名称和类别正确</span>
        </label>
      </div>
      <button
        className="mobile-action mobile-action--secondary ingredient-card__delete"
        type="button"
        onClick={onDelete}
      >
        删除材料 {rowNumber}
      </button>
    </article>
  );
}
