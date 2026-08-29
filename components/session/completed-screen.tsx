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
    <section className="completed-screen" aria-label="调饮完成">
      <header className="completed-screen__hero">
        <p className="mobile-eyebrow">完成</p>
        <div className="completed-stamp">COMPLETED</div>
        <h1>
          贵州风味，
          <br />
          已被你喝出来。
        </h1>
        <p>这一轮调饮实验已经完成，感谢你的记录。</p>
      </header>

      {recipe !== null ? (
        <div className="completed-screen__recipe">
          <p className="mobile-eyebrow">
            最终配方 · V{recipe.version} · {recipe.candidate.title}
          </p>
          <p>
            {safetyLabel(recipe)}
            {recipe.safety.reasons.length > 0 ? ` · ${recipe.safety.reasons[0]}` : ""}
          </p>
          <ul>
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
