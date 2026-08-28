interface WarningConfirmationProps {
  recipeTitle: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function WarningConfirmation({ recipeTitle, checked, onChange }: WarningConfirmationProps) {
  return (
    <label className="flex min-h-11 items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
      <input
        className="mt-1 size-5 shrink-0 accent-amber-700"
        type="checkbox"
        checked={checked}
        aria-label={`确认 ${recipeTitle} 的 WARN 提示`}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>我已阅读并理解该 WARN 提示，愿意谨慎少量尝试。</span>
    </label>
  );
}
