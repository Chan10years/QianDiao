"use client";

import type { ReactNode } from "react";

export function FixedActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="mobile-action-bar" role="region" aria-label="当前操作">
      <div className="mobile-action-bar__inner">{children}</div>
    </div>
  );
}
