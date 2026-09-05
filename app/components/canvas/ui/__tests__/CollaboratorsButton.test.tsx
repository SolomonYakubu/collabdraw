// @vitest-environment jsdom
/**
 * The people button, and the roster that hangs off it.
 *
 * Three things here are the way they are because of a specific failure:
 *
 *  - **The panel is portalled and positioned from the button's rect.** The tool
 *    island is a horizontal scroll container, so an absolutely positioned child
 *    would be clipped by it — the roster would open inside the island and be cut
 *    off at its edge.
 *  - **The name field commits on unmount.** Clicking away closes the panel, which
 *    unmounts the field before `blur` can fire; without the cleanup commit, the
 *    name you just typed is silently thrown away.
 *  - **Escape inside the field does not close the panel.** It means "undo my
 *    typing", so the field stops the event before the panel's handler sees it.
 *
 * jsdom measures everything as 0×0, so the button's rect is stubbed wherever the
 * position is what is being asserted.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CollaboratorsButton, {
  type CollaboratorsButtonProps,
} from "../CollaboratorsButton";
import { MAX_USER_NAME_LENGTH } from "../../../../services/collaboration/identity";

const ROOM = [
  { id: "me", tag: "Ada" },
  { id: "peer", tag: "Grace" },
];

const show = (overrides: Partial<CollaboratorsButtonProps> = {}) => {
  const props: CollaboratorsButtonProps = {
    users: ROOM,
    currentUserId: "me",
    userName: "Ada",
    onRenameUser: vi.fn(() => true),
    ...overrides,
  };
  const view = render(<CollaboratorsButton {...props} />);

  const update = (next: Partial<CollaboratorsButtonProps>) => {
    Object.assign(props, next);
    view.rerender(<CollaboratorsButton {...props} />);
  };

  return { ...view, props, update };
};

const peopleButton = () => screen.getByRole("button", { name: "Collaborators" });
const panel = () => document.querySelector<HTMLElement>('.island.fixed');
const rows = () => Array.from(document.querySelectorAll("li")).map((row) => row.textContent);
const nameField = () => screen.getByLabelText("Your name") as HTMLInputElement;

const openPanel = () => fireEvent.click(peopleButton());

/** Place the button, since jsdom has no layout and the panel follows its rect. */
const buttonAt = (rect: { bottom: number; left: number; right: number }) =>
  vi.spyOn(peopleButton(), "getBoundingClientRect").mockReturnValue({
    ...rect,
    top: rect.bottom - 36,
    width: rect.right - rect.left,
    height: 36,
    x: rect.left,
    y: rect.bottom - 36,
    toJSON: () => ({}),
  });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("the button", () => {
  it("carries the number of people in the room", () => {
    // The count is the only always-visible sign that anyone else is here; the
    // cursors only show while they are moving.
    show({ users: ROOM });

    expect(peopleButton().textContent).toBe("2");
  });

  it("shows no number when you are on your own", () => {
    // Not "0": a zero beside the icon reads as a fault, and an empty room is the
    // normal state of a board nobody has joined.
    show({ users: [] });

    expect(peopleButton().textContent).toBe("");
  });

  it("opens the roster and closes it again", () => {
    show();

    openPanel();
    expect(panel()).toBeTruthy();
    expect(peopleButton().getAttribute("aria-expanded")).toBe("true");

    openPanel();

    expect(panel()).toBeNull();
    expect(peopleButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("says it opens something, and marks itself while it is open", () => {
    show();

    expect(peopleButton().getAttribute("aria-haspopup")).toBe("true");

    openPanel();

    expect(peopleButton().getAttribute("data-active")).toBe("true");
  });
});

describe("the roster", () => {
  it("hangs off the body, not inside the scrolling island", () => {
    /*
     * The tool island scrolls horizontally on a narrow window. A panel nested
     * inside it is clipped at the island's edge — which is where the roster used
     * to be cut in half.
     */
    const { container } = show();

    openPanel();

    expect(container.querySelector(".island.fixed")).toBeNull();
    expect(document.body.contains(panel()!)).toBe(true);
  });

  it("lists everyone who is here", () => {
    show({ users: ROOM, currentUserId: "peer" });

    openPanel();

    expect(rows()).toEqual(["Ada", "Grace(you)"]);
  });

  it("says which one is you", () => {
    // Names repeat — two guests are both "Anonymous" — so the roster has to mark
    // your own row rather than leave you to work it out.
    show({ currentUserId: "peer" });

    openPanel();

    expect(rows()[1]).toContain("(you)");
  });

  it("says so plainly when nobody else has joined", () => {
    show({ users: [] });

    openPanel();

    expect(screen.getByText("Nobody else is here yet.")).toBeTruthy();
  });

  it("is not a menu, since it holds a text field", () => {
    // A `role="menu"` may only contain menu items; an input inside one is
    // announced as a menu item and its own role is lost.
    show();

    openPanel();

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(panel()!.getAttribute("aria-label")).toBe("Collaborators");
  });
});

describe("where the panel lands", () => {
  it("sits under the button, right-aligned to it", () => {
    // Right-aligned because the people button is near the right end of the
    // island; a left-aligned panel would run off the window.
    show();
    buttonAt({ bottom: 60, left: 500, right: 540 });

    openPanel();

    // 540 − 216 wide, and eight below the button.
    expect([panel()!.style.top, panel()!.style.left]).toEqual(["68px", "324px"]);
  });

  it("left-aligns when it is asked to", () => {
    // The mobile header puts this button at the left end of its row.
    show({ align: "left" });
    buttonAt({ bottom: 60, left: 300, right: 340 });

    openPanel();

    expect(panel()!.style.left).toBe("300px");
  });

  it("stays on screen when the button is near the left edge", () => {
    // Right-aligning a button that is 40px from the left would put the panel at
    // −176 and hide most of the roster off the side of the window.
    show();
    buttonAt({ bottom: 60, left: 8, right: 48 });

    openPanel();

    expect(panel()!.style.left).toBe("8px");
  });

  it("stays on screen when the button is near the right edge", () => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    show({ align: "left" });
    buttonAt({ bottom: 60, left: 760, right: 800 });

    openPanel();

    // 800 − 216 − 8: the last position that still shows the whole panel.
    expect(panel()!.style.left).toBe("576px");
  });

  it("measures again each time it is opened", () => {
    // The island scrolls and the window resizes; a position captured once would
    // leave the panel behind where the button used to be.
    show();
    const first = buttonAt({ bottom: 60, left: 500, right: 540 });

    openPanel();
    openPanel();
    first.mockRestore();
    buttonAt({ bottom: 90, left: 400, right: 440 });
    openPanel();

    expect([panel()!.style.top, panel()!.style.left]).toEqual(["98px", "224px"]);
  });
});

describe("closing it", () => {
  it("closes on a press anywhere else", () => {
    show();
    openPanel();

    fireEvent.pointerDown(document.body);

    expect(panel()).toBeNull();
  });

  it("stays open for a press inside the panel", () => {
    // The press that puts the caret in the name field is a press inside.
    show();
    openPanel();

    fireEvent.pointerDown(nameField());

    expect(panel()).toBeTruthy();
  });

  it("leaves the button's own press to the button", () => {
    /*
     * The outside-press listener is in the capture phase, so it sees the press
     * before the click reaches the toggle. Were the button not excluded, a click
     * on it would close the panel and then reopen it — and it would never close.
     */
    show();
    openPanel();

    fireEvent.pointerDown(peopleButton());

    expect(panel()).toBeTruthy();
  });

  it("closes on Escape", () => {
    show();
    openPanel();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(panel()).toBeNull();
  });

  it("closes when the window is resized", () => {
    // The panel is positioned from a rect measured at open time; after a resize
    // that rect describes somewhere the button no longer is.
    show();
    openPanel();

    fireEvent(window, new Event("resize"));

    expect(panel()).toBeNull();
  });

  it("stops listening once it is closed", () => {
    // Three listeners on `window`, one of them capturing every press on the
    // board. They exist only while the roster is up.
    show();
    openPanel();
    openPanel();

    expect(() => {
      fireEvent.pointerDown(document.body);
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent(window, new Event("resize"));
    }).not.toThrow();
    expect(panel()).toBeNull();
  });

  it("takes them with it when the toolbar goes", () => {
    const { unmount } = show();
    openPanel();

    unmount();

    expect(() => fireEvent.keyDown(window, { key: "Escape" })).not.toThrow();
  });
});

describe("your own name", () => {
  it("is offered for editing at the top of the roster", () => {
    // The panel already answers "who is in this room", so it is where you fix
    // the answer it gives about you.
    show({ userName: "Ada" });

    openPanel();

    expect(nameField().value).toBe("Ada");
    expect(nameField().maxLength).toBe(MAX_USER_NAME_LENGTH);
  });

  it("is left out when there is nobody to tell about a change", () => {
    // On a board with no socket there is nothing to rename yourself to.
    show({ onRenameUser: undefined });

    openPanel();

    expect(screen.queryByLabelText("Your name")).toBeNull();
  });

  it("starts empty rather than undefined when no name is known yet", () => {
    // A controlled input given `undefined` switches to uncontrolled and warns.
    show({ userName: undefined });

    openPanel();

    expect(nameField().value).toBe("");
  });

  it("commits on Enter", () => {
    const { props } = show({ userName: "Ada" });
    openPanel();

    fireEvent.change(nameField(), { target: { value: "Ada Lovelace" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });

    expect(props.onRenameUser).toHaveBeenCalledWith("Ada Lovelace");
  });

  it("commits on the way out of the field", () => {
    const { props } = show({ userName: "Ada" });
    openPanel();

    fireEvent.change(nameField(), { target: { value: "Ada Lovelace" } });
    fireEvent.blur(nameField());

    expect(props.onRenameUser).toHaveBeenCalledWith("Ada Lovelace");
  });

  it("commits what was typed when the panel is clicked away", () => {
    /*
     * This is the bug the unmount commit exists for: closing the panel unmounts
     * the field, and the unmount beats the `blur`, so the name was lost every
     * time it was set by typing and then clicking back onto the canvas.
     */
    const { props } = show({ userName: "Ada" });
    openPanel();
    fireEvent.change(nameField(), { target: { value: "Ada Lovelace" } });

    fireEvent.pointerDown(document.body);

    expect(props.onRenameUser).toHaveBeenCalledWith("Ada Lovelace");
  });

  it("says nothing when the name was not actually changed", () => {
    // Opening the panel and closing it again is not a rename; a commit here
    // would broadcast a name change to the whole room on every glance.
    const { props } = show({ userName: "Ada" });
    openPanel();

    fireEvent.blur(nameField());
    openPanel();

    expect(props.onRenameUser).not.toHaveBeenCalled();
  });

  it("puts back the name you had when the new one is refused", () => {
    // Whitespace, or a name the identity service will not store. The field must
    // not sit there showing a name that is not yours.
    const onRenameUser = vi.fn(() => false);
    show({ userName: "Ada", onRenameUser });
    openPanel();

    fireEvent.change(nameField(), { target: { value: "   " } });
    fireEvent.blur(nameField());

    expect(onRenameUser).toHaveBeenCalledWith("   ");
    expect(nameField().value).toBe("Ada");
  });

  it("does not write to a field that has already gone", () => {
    /*
     * A refused rename during the closing commit would otherwise set state on an
     * unmounted field — a console error every time an unusable name is typed and
     * the panel clicked away, which is exactly when it happens.
     */
    const complaints = vi.spyOn(console, "error").mockImplementation(() => {});
    show({ userName: "Ada", onRenameUser: vi.fn(() => false) });
    openPanel();
    fireEvent.change(nameField(), { target: { value: "   " } });

    fireEvent.pointerDown(document.body);

    expect(complaints).not.toHaveBeenCalled();
  });

  it("reverts on Escape without closing the roster", () => {
    /*
     * Escape in a text field means "undo my typing". The panel is also listening
     * for Escape, so the field has to stop the event — otherwise one press both
     * reverts the name and shuts the panel.
     */
    show({ userName: "Ada" });
    openPanel();
    fireEvent.change(nameField(), { target: { value: "Ada Lovelace" } });

    fireEvent.keyDown(nameField(), { key: "Escape" });

    expect(nameField().value).toBe("Ada");
    expect(panel()).toBeTruthy();
  });

  it("follows the stored name when it changes underneath", () => {
    // The name can be changed in another tab, or by the menu's rename dialog;
    // the field is seeded from a prop and has to keep up with it.
    const { update } = show({ userName: "Ada" });
    openPanel();

    update({ userName: "Ada Lovelace" });

    expect(nameField().value).toBe("Ada Lovelace");
  });
});
