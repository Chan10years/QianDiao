"use client";

import type { VersionedRecipeReadModel } from "@/src/infrastructure/http/session-client";

export interface CompletedScreenProps {
  recipe: VersionedRecipeReadModel | null;
}

const SAFETY_LEVEL_LABELS: Record<string, string> = {
  ALLOW: "安全通过",
  WARN: "安全警告",
  BLOCK: "安全未通过",
};

function safetyLabel(recipe: VersionedRecipeReadModel): string {
  return SAFETY_LEVEL_LABELS[recipe.safety.level] ?? "安全状态未知";
}

/**
 * Task 6：会话完成页。
 *
 * 支持完成状态恢复：刷新后 session 处于 COMPLETED 时直接渲染本页，
 * 配方信息从只读的 adjustment 状态恢复（可为 null，恢复期间先展示完成结论）。
 * 不提供分享、海报或任何写操作入口。
 */
export function CompletedScreen({ recipe }: CompletedScreenProps) {
  return (
    <section className="mobile-screen space-y-6" aria-label="调饮完成">
      <header className="mobile-page-header">
        <p className="mobile-eyebrow">完成</p>
        <h1>调饮完成</h1>
        <p>这一轮调饮实验已经完成，感谢你的记录。</p>
      </header>

      {recipe !== null ? (
        <div className="mobile-surface space-y-2 p-6">
          <p className="mobile-eyebrow">
            最终配方 · V{recipe.version} · {recipe.candidate.title}
          </p>
          <p className="text-sm leading-6 text-stone-700">
            {safetyLabel(recipe)}
            {recipe.safety.reasons.length > 0 ? ` · ${recipe.safety.reasons[0]}` : ""}
          </p>
          <ul className="space-y-1 text-sm leading-6 text-stone-700">
            {recipe.candidate.materials.map((material) => (
              <li key={`${material.name}-${material.amountMl}`}>
                {material.name} · {material.amountMl} {material.unit}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
