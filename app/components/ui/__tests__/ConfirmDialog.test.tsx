// @vitest-environment jsdom
/**
 * The replacement for `window.confirm()` — so the things it replaced must all
 * still work: it opens, it answers through its callbacks, Escape and the
 * backdrop mean "no", and the keys it swallows do not reach the canvas below.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ConfirmDialog from "../ConfirmDialog";

const open = (props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ConfirmDialog
      open
      title="Reset the canvas?"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { ...view, onConfirm, onCancel };
};

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <ConfirmDialog
        open={false}
        title="Reset the canvas?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("announces itself as a modal dialog labelled by its title", () => {
    open({ description: "This cannot be undone." });

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("Reset the canvas?");
    expect(dialog.textContent).toContain("This cannot be undone.");
  });

  it("focuses the confirm button, so Enter answers the question", () => {
    open({ confirmLabel: "Reset" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reset" }),
    );
  });

  it("answers through onConfirm and onCancel", () => {
    const { onConfirm, onCancel } = open({
      confirmLabel: "Reset",
      cancelLabel: "Keep it",
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("treats Escape and a backdrop click as cancelling", () => {
    const { onCancel, unmount } = open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();

    const second = open();
    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(second.onCancel).toHaveBeenCalledTimes(1);
  });

  it("swallows canvas shortcuts while it is open", () => {
    const onWindowKeyDown = vi.fn();
    window.addEventListener("keydown", onWindowKeyDown);
    open();

    // "r" is the rectangle tool; Delete removes the selection.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "r" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Delete" });
    expect(onWindowKeyDown).not.toHaveBeenCalled();

    // Tab is deliberately let through, so focus still moves.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(onWindowKeyDown).toHaveBeenCalledTimes(1);

    window.removeEventListener("keydown", onWindowKeyDown);
  });

  it("paints the confirm button as destructive when asked", () => {
    open({ danger: true, confirmLabel: "Delete" });
    expect(
      screen.getByRole("button", { name: "Delete" }).className,
    ).toContain("btn--danger");
  });

  it("offers two answers unless a third is given", () => {
    open({ confirmLabel: "Reset", cancelLabel: "Keep it" });
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("carries a second way to say yes, separately from cancelling", () => {
    // "Keep a copy" and "Leave without keeping" both leave the room; only "Stay"
    // means no. So the third button must not be wired to either of the others.
    const onSelect = vi.fn();
    const { onConfirm, onCancel } = open({
      confirmLabel: "Keep a copy",
      cancelLabel: "Stay",
      secondaryAction: { label: "Leave without keeping", onSelect },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Leave without keeping" }),
    );

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("still focuses confirm, so Enter takes the recommended answer", () => {
    open({
      confirmLabel: "Keep a copy",
      secondaryAction: { label: "Leave without keeping", onSelect: vi.fn() },
    });

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Keep a copy" }),
    );
  });
});
