// @vitest-environment jsdom
/**
 * The replacement for `window.prompt()` — used for naming and renaming boards.
 *
 * What `prompt()` gave for free is what this has to be tested for: the field is
 * focused and its contents selected, so the first keystroke replaces the old
 * name; Enter accepts; a cancelled dialog is distinguishable from an empty
 * answer, which here means the confirm button refuses rather than committing a
 * board called "" or "   ".
 *
 * The seeding is the other half. The dialog stays mounted between openings, so
 * without the reseeding effect the second rename opens on whatever was typed and
 * abandoned during the first.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import PromptDialog from "../PromptDialog";

const onConfirm = vi.fn();
const onCancel = vi.fn();

const show = (
  props: Partial<React.ComponentProps<typeof PromptDialog>> = {},
) => {
  const view = render(
    <PromptDialog
      open
      title="Rename board"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );

  /** Reopen, or reopen against a different board, without remounting. */
  const update = (next: Partial<React.ComponentProps<typeof PromptDialog>>) =>
    view.rerender(
      <PromptDialog
        open
        title="Rename board"
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
        {...next}
      />,
    );

  return { ...view, update };
};

/*
 * By role, not by label: the dialog is itself labelled by its title, so a query
 * for that text matches both the dialog and the field inside it.
 */
const field = () => screen.getByRole("textbox") as HTMLInputElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const button = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("opening", () => {
  it("starts from the current name, ready to be typed over", () => {
    // Selected rather than merely focused: renaming is usually replacing, and an
    // unselected field makes the user clear it first.
    show({ initialValue: "Sprint planning" });

    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("Sprint planning");
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe("Sprint planning".length);
  });

  it("starts empty when there is nothing to rename", () => {
    show();

    expect(field().value).toBe("");
  });

  it("shows the field's purpose to a screen reader", () => {
    // There is no visible label — the dialog title is the label, and this is the
    // assertion that keeps them attached.
    show({ title: "Name this board" });

    expect(screen.getByRole("textbox", { name: "Name this board" })).toBe(
      field(),
    );
  });

  it("passes the placeholder and the limit to the field", () => {
    // The limit is what stops a pasted document becoming a board name; boards
    // are listed by name, and the list has one line for each.
    show({ placeholder: "Untitled board", maxLength: 40 });

    expect(field().placeholder).toBe("Untitled board");
    expect(field().maxLength).toBe(40);
  });

  it("limits the name even when the caller says nothing", () => {
    show();

    expect(field().maxLength).toBe(120);
  });

  it("renders nothing while closed", () => {
    show({ open: false });

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("seeding", () => {
  it("forgets what was typed and abandoned last time", () => {
    /*
     * The dialog is mounted once and opened repeatedly, so its state outlives a
     * cancel. Without the reseed, the next rename opens on the abandoned draft
     * of the previous one.
     */
    const { update } = show({ initialValue: "Sprint planning" });
    type("Half a new n");

    update({ open: false });
    update({ open: true });

    expect(field().value).toBe("Sprint planning");
  });

  it("follows the board it was pointed at", () => {
    // The dashboard reuses one dialog for every row. Renaming a second board
    // must not offer the first board's name.
    const { update } = show({ initialValue: "Sprint planning" });

    update({ initialValue: "Retro notes" });

    expect(field().value).toBe("Retro notes");
  });
});

describe("answering", () => {
  it("hands back what was typed, trimmed", () => {
    // Leading and trailing space is invisible in a board list, so two boards
    // would appear to have the same name.
    show();

    type("  Retro notes  ");
    fireEvent.click(button("Save"));

    expect(onConfirm).toHaveBeenCalledWith("Retro notes");
  });

  it("accepts on Enter, the way prompt() did", () => {
    show({ initialValue: "Retro notes" });

    fireEvent.submit(field().closest("form")!);

    expect(onConfirm).toHaveBeenCalledWith("Retro notes");
  });

  it("refuses an empty answer instead of committing a nameless board", () => {
    show();

    expect(button("Save").disabled).toBe(true);

    fireEvent.submit(field().closest("form")!);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("counts whitespace as empty", () => {
    // A field with a space in it looks filled and is not: the name it would
    // save shows as blank everywhere the board is listed.
    show({ initialValue: "Retro notes" });

    type("    ");

    expect(button("Save").disabled).toBe(true);
  });

  it("enables the button as soon as there is something to save", () => {
    show();

    type("R");

    expect(button("Save").disabled).toBe(false);
  });

  it("cancels through the button, the backdrop and Escape", () => {
    // Three ways out, all meaning the same thing, none of which may be mistaken
    // for confirming: a rename the user backed out of must leave the name alone.
    show({ initialValue: "Retro notes" });

    fireEvent.click(button("Cancel"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(
      screen.getByRole("dialog").parentElement!.querySelector(".absolute")!,
    );

    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses the labels it was given for both answers", () => {
    // "Save" is wrong for creating, and "Cancel" is wrong when backing out has
    // a consequence of its own.
    show({
      initialValue: "Retro notes",
      confirmLabel: "Create board",
      cancelLabel: "Not now",
    });

    fireEvent.click(button("Create board"));
    expect(onConfirm).toHaveBeenCalledWith("Retro notes");

    fireEvent.click(button("Not now"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
