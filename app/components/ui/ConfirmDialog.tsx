"use client";

/**
 * "Are you sure?" — the replacement for `window.confirm`.
 *
 * Rendered by the caller with `open` driven by state, so the answer arrives
 * through `onConfirm` rather than as a return value. That is the one real
 * difference from `confirm()`: the code around it cannot block waiting for a
 * click, so the action moves into the callback. `secondaryAction` is the other:
 * `confirm()` has exactly two answers, and some questions have three.
 */
import { useRef } from "react";

import Modal from "./Modal";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What is about to happen, and whether it can be undone. */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * A second way to say yes, for a question with two honest answers — leaving a
   * room while keeping a copy of its drawing, and leaving without one, are both
   * leaving. Cancelling is still the only way to say no, so this sits between the
   * two and is styled as neither: not the recommended path, not the way out.
   */
  secondaryAction?: { label: string; onSelect: () => void };
  /** Paints the confirm button as destructive. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  secondaryAction,
  danger = false,
  onConfirm,
  onCancel,
}) => {
  const confirmRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      initialFocusRef={confirmRef}
      footer={
        <>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          {secondaryAction && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={secondaryAction.onSelect}
            >
              {secondaryAction.label}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${danger ? "btn--danger" : "btn--primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    />
  );
};

export default ConfirmDialog;
