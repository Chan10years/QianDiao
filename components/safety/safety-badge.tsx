import type { RecipeSafetySummary } from "@/src/domain/recipe";

const levelLabel: Record<RecipeSafetySummary["level"], string> = {
  ALLOW: "安全：ALLOW",
  WARN: "注意：WARN",
  BLOCK: "不可选：BLOCK",
};

const levelIcon: Record<RecipeSafetySummary["level"], string> = {
  ALLOW: "✓",
  WARN: "⚠",
  BLOCK: "⛔",
};

export function SafetyBadge({ safety }: { safety: RecipeSafetySummary }) {
  return (
    <section
      aria-label={`Safety ${safety.level}`}
      className={`rounded-2xl border p-4 text-sm leading-6 ${
        safety.level === "ALLOW"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : safety.level === "WARN"
            ? "border-amber-200 bg-amber-50 text-amber-950"
            : "border-red-200 bg-red-50 text-red-900"
      }`}
    >
      <p className="font-semibold">
        <span aria-hidden="true" className="mr-2">
          {levelIcon[safety.level]}
        </span>
        {levelLabel[safety.level]}
      </p>
      <p className="mt-1">安全原因：{safety.reasons.join("；")}</p>
      {safety.alternatives.length > 0 ? (
        <p className="mt-1">安全替代：{safety.alternatives.join("；")}</p>
      ) : null}
    </section>
  );
}
