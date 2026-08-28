"use client";

/**
 * A one-field dialog — the replacement for `window.prompt`.
 *
 * The value is held here and handed to `onConfirm` trimmed; an empty field
 * disables the confirm button, which is the "cancelled" case `prompt()` signals
 * by returning null. Submitting the form (Enter) confirms.
 */
import { useEffect, useRef, useState } from "react";

import Modal from "./Modal";

export interface PromptDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** Seeds the field each time the dialog opens. */
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  maxLength?: number;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

const PromptDialog: React.FC<PromptDialogProps> = ({
  open,
  title,
  description,
  initialValue = "",
  placeholder,
  confirmLabel = "Save",
  cancelLabel = "Cancel",
  maxLength = 120,
  onConfirm,
  onCancel,
}) => {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reopening starts from the current name again, not from whatever was typed
  // and abandoned last time.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
    }
  }, [initialValue, open]);

  useEffect(() => {
    if (open) {
      // Selected, so typing replaces — the same feel as `prompt()`.
      inputRef.current?.select();
    }
  }, [open]);

  const trimmed = value.trim();

  const submit = () => {
    if (trimmed) {
      onConfirm(trimmed);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      initialFocusRef={inputRef}
      footer={
        <>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!trimmed}
            onClick={submit}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-label={title}
          className="field h-9 w-full px-3 text-sm"
        />
      </form>
    </Modal>
  );
};

export default PromptDialog;
