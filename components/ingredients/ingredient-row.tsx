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
    <article className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-stone-900">材料 {rowNumber}</h2>
          <p className="mt-1 text-xs text-stone-500">
            识别置信度 {Math.round(ingredient.confidence * 100)}%，请人工核对
          </p>
        </div>
        <button
          className="min-h-11 shrink-0 rounded-xl px-3 text-sm font-medium text-red-700 hover:bg-red-50"
          type="button"
          onClick={onDelete}
        >
          删除材料 {rowNumber}
        </button>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1.5 text-sm font-medium text-stone-800">
          <span>材料名称</span>
          <input
            className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 text-base font-normal"
            aria-label={`材料 ${rowNumber} 名称`}
            type="text"
            value={ingredient.canonicalName}
            onChange={(event) => update({ canonicalName: event.target.value })}
          />
        </label>

        <label className="block space-y-1.5 text-sm font-medium text-stone-800">
          <span>受控类别</span>
          <select
            className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 text-base font-normal"
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

        <label className="block space-y-1.5 text-sm font-medium text-stone-800">
          <span>品牌（可选）</span>
          <input
            className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 text-base font-normal"
            aria-label={`材料 ${rowNumber} 品牌`}
            type="text"
            value={ingredient.brand ?? ""}
            onChange={(event) => update({ brand: event.target.value || null })}
          />
        </label>

        <label className="block space-y-1.5 text-sm font-medium text-stone-800">
          <span>酒精度（ABV）</span>
          <input
            className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 text-base font-normal"
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

        <label className="flex min-h-11 items-center gap-3 text-sm font-medium text-stone-800">
          <input
            className="h-5 w-5 accent-amber-700"
            aria-label={`材料 ${rowNumber} 已确认`}
            type="checkbox"
            checked={ingredient.confirmed}
            onChange={(event) => update({ confirmed: event.target.checked })}
          />
          <span>我确认这项材料确实存在，名称和类别正确</span>
        </label>
      </div>
    </article>
  );
}
