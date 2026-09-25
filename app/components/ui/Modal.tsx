"use client";

/**
 * Modal dialog shell.
 *
 * The browser's `confirm()` and `prompt()` are unstyled, say "localhost:3000
 * says", cannot be themed, and block the main thread. Everything that used to
 * call them goes through this instead.
 *
 * Two details earn their keep:
 *
 *  - **Portalled to `document.body`.** The canvas surfaces live inside
 *    positioned, sometimes clipping, containers; a dialog nested in one would be
 *    trapped by it.
 *  - **Keystrokes stop here.** `useKeyboardShortcuts` listens on `window`, so
 *    with a dialog open and a button focused, "r" would still switch tools and
 *    Delete would still remove the selection. A capture-phase listener swallows
 *    keys unless they are being typed into a field inside the dialog, which
 *    leaves the input working while the canvas below stays inert.
 *  - **Focus stays in.** The dialog is a portal sibling of the app, so the
 *    browser's Tab order walks straight off the end of it and onto the controls
 *    behind the overlay. The same listener wraps Tab and Shift+Tab between the
 *    dialog's first and last focusable elements.
 */
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export interface ModalProps {
  open: boolean;
  title: string;
  /** Supporting line under the title. */
  description?: string;
  onClose: () => void;
  /** The dialog's body: a field, a warning, nothing at all. */
  children?: React.ReactNode;
  /** Buttons, right-aligned. */
  footer: React.ReactNode;
  /** Focused when the dialog opens; falls back to the dialog itself. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable);

/** Everything Tab can land on inside the dialog, in DOM order. */
const TABBABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const tabbablesIn = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR));

const Modal: React.FC<ModalProps> = ({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  initialFocusRef,
}) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus in on open, and back where it was on close.
  useEffect(() => {
    if (!open) {
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    (initialFocusRef?.current ?? dialogRef.current)?.focus();
    return () => previous?.focus?.();
  }, [initialFocusRef, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) {
          return;
        }

        const focusables = tabbablesIn(dialog);
        if (focusables.length === 0) {
          event.preventDefault();
          dialog.focus();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        // Focus on the dialog itself (its initial state) is not one of the
        // focusables, so a Shift+Tab from there would walk backwards out of the
        // portal. Treat it as the edge it is.
        const atEdge = !active || active === dialog || !dialog.contains(active);

        if (event.shiftKey ? atEdge || active === first : atEdge || active === last) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
        // Tab itself still propagates, so a host listening for it (as the
        // keyboard-shortcut tests do) keeps seeing it; only the default move is
        // replaced.
        return;
      }

      // Typing reaches the field; nothing else gets through to the canvas.
      if (!isTypingTarget(event.target)) {
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0"
        style={{ background: "var(--overlay)" }}
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="island animate-dialog-in relative w-full max-w-sm p-4 outline-none"
      >
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>

        {description && (
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            {description}
          </p>
        )}

        {children && <div className="mt-3">{children}</div>}

        {/* Wraps because a question with two ways to say yes needs three buttons,
            and three labels do not fit `max-w-sm` on a narrow phone. */}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {footer}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default Modal;
