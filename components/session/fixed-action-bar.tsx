"use client";

import type { ReactNode } from "react";

export function FixedActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(28,25,23,0.08)] backdrop-blur">
      <div className="mx-auto max-w-md">{children}</div>
    </div>
  );
}
