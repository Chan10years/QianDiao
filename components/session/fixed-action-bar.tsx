"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface MobileShellProps {
  busy: boolean;
  children: ReactNode;
}

interface ActionBarPresenceContextValue {
  register: () => () => void;
}

const ActionBarPresenceContext = createContext<ActionBarPresenceContextValue | null>(null);

export function MobileShell({ busy, children }: MobileShellProps) {
  const [actionBarCount, setActionBarCount] = useState(0);
  const register = useCallback(() => {
    setActionBarCount((count) => count + 1);
    return () => setActionBarCount((count) => Math.max(0, count - 1));
  }, []);
  const contextValue = useMemo(() => ({ register }), [register]);

  return (
    <ActionBarPresenceContext.Provider value={contextValue}>
      <main
        className="mobile-shell"
        data-shell-bottom-spacing={actionBarCount > 0 ? "action-bar" : "normal"}
        aria-label="调饮实验"
        aria-busy={busy}
      >
        {children}
      </main>
    </ActionBarPresenceContext.Provider>
  );
}

export function FixedActionBar({ children }: { children: ReactNode }) {
  const actionBarPresence = useContext(ActionBarPresenceContext);

  useLayoutEffect(() => actionBarPresence?.register(), [actionBarPresence]);

  return (
    <div className="mobile-action-bar" role="region" aria-label="当前操作">
      <div className="mobile-action-bar__inner">{children}</div>
    </div>
  );
}
