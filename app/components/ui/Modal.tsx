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
      // Tab keeps working (focus stays in the dialog because it is the only
      // thing on top), and typing reaches the field. Nothing else gets through
      // to the canvas.
      if (event.key !== "Tab" && !isTypingTarget(event.target)) {
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
