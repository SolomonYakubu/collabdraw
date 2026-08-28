"use client";

/**
 * Toasts — the app's one channel for "that worked" and "that did not".
 *
 * `useToasts` owns the list and the timers; `ToastStack` draws it. A toast is
 * addressable by id, so a long action can post "Saving…" with `duration: 0` and
 * then dismiss or replace it when the request comes back, rather than leaving
 * two messages stacked.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FiAlertCircle, FiCheck, FiInfo, FiX } from "react-icons/fi";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

export interface ShowToastOptions {
  kind?: ToastKind;
  /** Reuse an id to replace a toast in place. */
  id?: string;
  /** Milliseconds on screen; `0` stays until dismissed. */
  duration?: number;
}

/** Errors want reading; a confirmation does not. */
const DEFAULT_DURATION: Record<ToastKind, number> = {
  info: 2600,
  success: 2200,
  error: 6000,
};

let sequence = 0;

export interface ToastApi {
  toasts: Toast[];
  show: (message: string, options?: ShowToastOptions) => string;
  dismiss: (id: string) => void;
}

export const useToasts = (): ToastApi => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const show = useCallback(
    (message: string, options: ShowToastOptions = {}) => {
      const kind = options.kind ?? "info";
      const id = options.id ?? `toast-${++sequence}`;
      const duration = options.duration ?? DEFAULT_DURATION[kind];

      clearTimer(id);
      setToasts((current) => [
        ...current.filter((toast) => toast.id !== id),
        { id, kind, message },
      ]);

      if (duration > 0) {
        timers.current.set(
          id,
          window.setTimeout(() => dismiss(id), duration),
        );
      }

      return id;
    },
    [clearTimer, dismiss],
  );

  // Timers outliving the component would fire into a dead setState.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer));
      pending.clear();
    };
  }, []);

  return { toasts, show, dismiss };
};

const ICONS: Record<ToastKind, React.ReactNode> = {
  info: <FiInfo size={15} />,
  success: <FiCheck size={15} />,
  error: <FiAlertCircle size={15} />,
};

const ACCENTS: Record<ToastKind, string> = {
  info: "var(--text-muted)",
  success: "var(--success)",
  error: "var(--danger)",
};

/**
 * Top-centre, clear of the tool island. `aria-live="polite"` so a screen reader
 * hears the outcome without the focus moving.
 */
const ToastStack: React.FC<{
  toasts: Toast[];
  onDismiss: (id: string) => void;
}> = ({ toasts, onDismiss }) => (
  <div
    role="status"
    aria-live="polite"
    className="pointer-events-none fixed left-1/2 top-16 z-[80] flex w-[min(24rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col items-center gap-2"
  >
    {toasts.map((toast) => (
      <div
        key={toast.id}
        className="island animate-toast-in pointer-events-auto flex w-full items-center gap-2.5 px-3 py-2 text-sm"
        style={{
          borderColor:
            toast.kind === "error" ? "var(--danger)" : "var(--island-border)",
        }}
      >
        <span
          aria-hidden="true"
          className="shrink-0"
          style={{ color: ACCENTS[toast.kind] }}
        >
          {ICONS[toast.kind]}
        </span>
        <span className="flex-1">{toast.message}</span>
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          className="island-button h-6 w-6 shrink-0"
          aria-label="Dismiss"
        >
          <FiX size={13} />
        </button>
      </div>
    ))}
  </div>
);

export default ToastStack;
