"use client";

import { useTranslations } from "next-intl";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface ToastState {
  message: string;
  undo?: (() => void) | undefined;
  undoLabel?: string | undefined;
}

interface ToastApi {
  toast: (message: string, options?: { undo?: () => void; undoLabel?: string }) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => {} });

/** One bottom toast like the demo: message + optional Deshacer (docs/11: every automatic action can be undone). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const tApp = useTranslations("app");
  const [state, setState] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((message: string, options: { undo?: () => void; undoLabel?: string } = {}) => {
    setState({ message, undo: options.undo, undoLabel: options.undoLabel });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setState(null);
    }, 6500);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const api = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      {state ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-24 left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-3.5 rounded-xl bg-ink px-4 py-2.5 text-[13.5px] text-bg shadow-2xl md:bottom-6"
        >
          <span>{state.message}</span>
          {state.undo ? (
            <button
              type="button"
              className="font-bold underline"
              onClick={() => {
                state.undo?.();
                setState(null);
              }}
            >
              {state.undoLabel ?? tApp("undo")}
            </button>
          ) : null}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
