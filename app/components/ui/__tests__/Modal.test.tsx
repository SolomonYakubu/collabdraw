// @vitest-environment jsdom
/**
 * The dialog shell every dialog in the app is built from.
 *
 * `ConfirmDialog`'s tests cover the shell as its users meet it; these cover the
 * three things the shell does that its users cannot see, each of which broke
 * something real:
 *
 *  - **The portal.** The canvas surfaces sit in positioned, clipping containers.
 *    A dialog rendered where it was written would be cropped by one of them, so
 *    it goes to `document.body` instead — and the test asserts it left.
 *  - **Focus.** The dialog takes focus on open (its caller's field if it named
 *    one) and hands it back on close, or the user is left tabbing from the top of
 *    the page after every dialog.
 *  - **The keyboard.** `useKeyboardShortcuts` listens on `window`, so an open
 *    dialog has to swallow keys the canvas would otherwise act on — while still
 *    letting whatever is being typed into its own field through.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Modal from "../Modal";

const show = (props: Partial<React.ComponentProps<typeof Modal>> = {}) => {
  const onClose = vi.fn();
  const view = render(
    <Modal
      open
      title="Rename the board"
      onClose={onClose}
      footer={<button type="button">Save</button>}
      {...props}
    />,
  );
  return { ...view, onClose };
};

afterEach(cleanup);

describe("where it renders", () => {
  it("escapes the tree it was written in", () => {
    // Written inside a clipping container, drawn outside it: `overflow: hidden`
    // on any ancestor would otherwise crop the dialog.
    const { container } = render(
      <div style={{ overflow: "hidden" }}>
        <Modal open title="Rename the board" onClose={vi.fn()} footer={null} />
      </div>,
    );

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.contains(screen.getByRole("dialog"))).toBe(true);
  });

  it("renders nothing at all while closed", () => {
    show({ open: false });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves out the description and the body when it has none", () => {
    // Both are wrapped in spacing elements. An empty wrapper is not invisible:
    // it opens a gap above the buttons where the body should have been.
    show();

    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".mt-1")).toBeNull();
    expect(dialog.querySelector(".mt-3")).toBeNull();
  });

  it("wraps the body it is given", () => {
    show({ children: <p>Everything on this board goes.</p> });

    expect(screen.getByRole("dialog").querySelector(".mt-3")?.textContent).toBe(
      "Everything on this board goes.",
    );
  });

  it("shows the supporting line under the title", () => {
    // The consequence of the answer usually cannot be fitted into the title,
    // and this is where "this cannot be undone" has to appear.
    show({ description: "Everyone in the room sees the new name." });

    expect(screen.getByRole("dialog").textContent).toContain(
      "Everyone in the room sees the new name.",
    );
  });

  it("labels itself with its own title, whatever else is on the page", () => {
    // Two dialogs in one app cannot share a hard-coded id, so the id is minted
    // per instance and has to be the one `aria-labelledby` points at.
    show();

    const dialog = screen.getByRole("dialog");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe(
      "Rename the board",
    );
  });
});

describe("focus", () => {
  it("takes it, so the keyboard is inside the dialog", () => {
    show();

    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("gives it to the field the caller named", () => {
    // `PromptDialog` points this at its input: the dialog exists to be typed
    // into, and a dialog that focuses itself makes the user click first.
    const ref = createRef<HTMLInputElement>();
    show({
      initialFocusRef: ref,
      children: <input ref={ref} aria-label="Board name" />,
    });

    expect(document.activeElement).toBe(screen.getByLabelText("Board name"));
  });

  it("still focuses itself when the named field never rendered", () => {
    // A ref whose element is conditional is empty on the render that opens the
    // dialog; focusing nothing would leave the keyboard on the canvas below.
    show({ initialFocusRef: createRef<HTMLElement>() });

    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("hands it back to whatever had it, on close", () => {
    // The user pressed a toolbar button to get here. Losing the place means
    // tabbing from the top of the document again.
    render(<button type="button">Rename</button>);
    const opener = screen.getByRole("button", { name: "Rename" });
    opener.focus();

    const { rerender } = show();
    expect(document.activeElement).not.toBe(opener);

    rerender(
      <Modal
        open={false}
        title="Rename the board"
        onClose={vi.fn()}
        footer={null}
      />,
    );

    expect(document.activeElement).toBe(opener);
  });

  it("hands it back when the dialog is unmounted outright", () => {
    // Navigating away unmounts rather than closing, and the ref to the element
    // that had focus is only held by the effect that has to run.
    render(<button type="button">Rename</button>);
    const opener = screen.getByRole("button", { name: "Rename" });
    opener.focus();

    show().unmount();

    expect(document.activeElement).toBe(opener);
  });
});

describe("the keyboard", () => {
  /** A listener on `window` stands in for `useKeyboardShortcuts`. */
  const watchWindow = () => {
    const seen: string[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listener);
    return {
      seen,
      stop: () => window.removeEventListener("keydown", listener),
    };
  };

  it("closes on Escape without the canvas hearing it", () => {
    // Escape also clears the selection and cancels the current tool. One press
    // should close the dialog and do nothing else.
    const canvas = watchWindow();
    const { onClose } = show();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(canvas.seen).toEqual([]);
    canvas.stop();
  });

  it("swallows the shortcuts the canvas is listening for", () => {
    /*
     * With a dialog open and its confirm button focused, "r" would still switch
     * to the rectangle tool and Delete would still remove the selection — the
     * user's board changed underneath a dialog they had not answered yet. Tab is
     * the exception: focus has to keep moving between the dialog's own controls.
     */
    const canvas = watchWindow();
    show();
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(dialog, { key: "r" });
    fireEvent.keyDown(dialog, { key: "Delete" });
    expect(canvas.seen).toEqual([]);

    fireEvent.keyDown(dialog, { key: "Tab" });

    expect(canvas.seen).toEqual(["Tab"]);
    canvas.stop();
  });

  it("lets what is typed into its own field through", () => {
    // The keys the canvas must not see are the same keys a name is made of, so
    // the test is that the field still receives them.
    const ref = createRef<HTMLInputElement>();
    show({
      initialFocusRef: ref,
      children: <input ref={ref} aria-label="Board name" />,
    });
    const field = screen.getByLabelText("Board name");

    fireEvent.change(field, { target: { value: "Sprint 12" } });

    expect((field as HTMLInputElement).value).toBe("Sprint 12");
  });

  it("does not swallow keys pressed inside a field", () => {
    const canvas = watchWindow();
    const ref = createRef<HTMLTextAreaElement>();
    show({
      initialFocusRef: ref,
      children: <textarea ref={ref} aria-label="Notes" />,
    });

    fireEvent.keyDown(screen.getByLabelText("Notes"), { key: "e" });

    expect(canvas.seen).toEqual(["e"]);
    canvas.stop();
  });

  it("treats an editable region as a field too", () => {
    // The canvas's own text editing uses a contenteditable, which has neither
    // tag name; typing in one must not be mistaken for a shortcut. jsdom does
    // not implement editing, so `isContentEditable` is set here the way a
    // browser would report it for the attribute below.
    const canvas = watchWindow();
    show({
      children: <div contentEditable suppressContentEditableWarning />,
    });
    const editable = screen
      .getByRole("dialog")
      .querySelector("[contenteditable]")!;
    Object.defineProperty(editable, "isContentEditable", { value: true });

    fireEvent.keyDown(editable, { key: "e" });

    expect(canvas.seen).toEqual(["e"]);
    canvas.stop();
  });

  it("stops listening once it is closed", () => {
    // A closed dialog that still swallowed keys would leave the canvas dead for
    // the rest of the session, with nothing on screen to explain why.
    const canvas = watchWindow();
    const { rerender } = show();

    rerender(
      <Modal
        open={false}
        title="Rename the board"
        onClose={vi.fn()}
        footer={null}
      />,
    );
    fireEvent.keyDown(document.body, { key: "r" });

    expect(canvas.seen).toEqual(["r"]);
    canvas.stop();
  });
});

describe("the backdrop", () => {
  it("closes when clicked, the way clicking outside a dialog should", () => {
    const { onClose } = show();

    fireEvent.click(
      screen.getByRole("dialog").parentElement!.querySelector(".absolute")!,
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is hidden from screen readers, being nothing but a dimmed layer", () => {
    show();

    const backdrop = screen
      .getByRole("dialog")
      .parentElement!.querySelector(".absolute")!;
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
  });
});
