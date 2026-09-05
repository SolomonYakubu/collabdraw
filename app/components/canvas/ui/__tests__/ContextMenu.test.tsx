// @vitest-environment jsdom
/**
 * The canvas right-click menu.
 *
 * Two bugs are on the record for this component, and both are in the docblock of
 * the file it replaced: it measured itself through a ref that was still null
 * during render, so the "keep it on screen" adjustment never ran; and it put a
 * document-wide `contextmenu` handler in place that outlived the menu.
 *
 * So the tests here are mostly about the edges and the exits. The measurement
 * happens in a layout effect and is asserted against a stubbed rect, because a
 * menu opened near the right edge of the window is exactly the case that used to
 * hang off it. And there are four ways to dismiss — Escape, a press outside, the
 * wheel, choosing something — each of which has to remove its own listener, or
 * every later right-click closes a menu that is not there.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ContextMenu, { type ContextMenuItem } from "../ContextMenu";

const onClose = vi.fn();

const item = (
  label: string,
  extra: Partial<ContextMenuItem> = {},
): ContextMenuItem => ({ label, onSelect: vi.fn(), ...extra });

const openAt = (
  { x = 40, y = 40 }: { x?: number; y?: number } = {},
  items: ContextMenuItem[] = [item("Paste")],
) => {
  const view = render(<ContextMenu x={x} y={y} items={items} onClose={onClose} />);
  const menu = () => screen.getByRole("menu");
  return { ...view, items, menu };
};

const entry = (name: string | RegExp) =>
  screen.getByRole("menuitem", { name }) as HTMLButtonElement;

const positionOf = (menu: HTMLElement) => [menu.style.left, menu.style.top];

/**
 * Give the menu a size, since jsdom measures everything as 0×0 and the whole
 * point of the adjustment is subtracting the menu's own width from the edge.
 */
const measuringAs = (width: number, height: number) =>
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  });

/**
 * Put the menu inside a positioned box of a given size, as the canvas wrapper is
 * in the app. jsdom has no layout, so `offsetParent` has to be supplied.
 */
const insideABoxOf = (width: number, height: number) => {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetParent",
  );
  const parent = {
    getBoundingClientRect: () => ({ width, height }),
  } as unknown as Element;

  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get: () => parent,
  });

  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, "offsetParent", original);
    } else {
      delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
    }
  };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("the items", () => {
  it("lists them in the order it was given", () => {
    const { menu } = openAt({}, [item("Copy"), item("Paste"), item("Delete")]);

    expect(
      Array.from(menu().querySelectorAll('[role="menuitem"]')).map(
        (button) => button.textContent,
      ),
    ).toEqual(["Copy", "Paste", "Delete"]);
  });

  it("shows the shortcut beside the ones that have one", () => {
    // The menu is where a user learns that Ctrl+D duplicates; the label alone
    // teaches nothing.
    openAt({}, [item("Duplicate", { shortcut: "Ctrl+D" }), item("Copy")]);

    expect(entry(/Duplicate/).textContent).toBe("DuplicateCtrl+D");
    expect(entry("Copy").textContent).toBe("Copy");
  });

  it("acts, then closes", () => {
    // Both, in that order: the menu closing first would unmount the handler
    // before the action ran.
    const chosen: string[] = [];
    const items = [
      item("Bring to front", { onSelect: () => chosen.push("selected") }),
    ];
    onClose.mockImplementation(() => chosen.push("closed"));
    openAt({}, items);

    fireEvent.click(entry("Bring to front"));

    expect(chosen).toEqual(["selected", "closed"]);
  });

  it("does nothing for an item that is not available", () => {
    // "Paste" with an empty clipboard, for instance: it stays listed so the menu
    // does not reshuffle under the pointer, but it is inert.
    const items = [item("Paste", { disabled: true })];
    openAt({}, items);

    expect(entry("Paste").disabled).toBe(true);
    fireEvent.click(entry("Paste"));

    expect(items[0].onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("marks a destructive item, and a disabled one, by colour", () => {
    openAt({}, [
      item("Delete", { danger: true }),
      item("Paste", { disabled: true }),
      item("Copy"),
    ]);

    expect(entry("Delete").style.color).toBe("var(--danger)");
    expect(entry("Paste").style.color).toBe("var(--text-faint)");
    expect(entry("Paste").style.cursor).toBe("not-allowed");
    expect(entry("Copy").style.color).toBe("var(--text)");
  });

  it("highlights under the pointer, in the item's own colour", () => {
    // There is no hover state in the stylesheet for these; the component sets it,
    // so a danger item highlights red rather than grey.
    openAt({}, [item("Delete", { danger: true }), item("Copy")]);

    fireEvent.mouseEnter(entry("Delete"));
    fireEvent.mouseEnter(entry("Copy"));

    expect(entry("Delete").style.background).toBe("var(--danger-bg)");
    expect(entry("Copy").style.background).toBe("var(--hover-bg)");

    fireEvent.mouseLeave(entry("Copy"));

    expect(entry("Copy").style.background).toBe("transparent");
  });

  it("leaves a disabled item unhighlighted, since it cannot be chosen", () => {
    openAt({}, [item("Paste", { disabled: true })]);

    fireEvent.mouseEnter(entry("Paste"));

    expect(entry("Paste").style.background).toBe("transparent");
  });

  it("groups with dividers, but never opens with one", () => {
    // A divider above the first item is a stray line across the top of the menu.
    const { menu } = openAt({}, [
      item("Copy", { separatorBefore: true }),
      item("Delete", { separatorBefore: true }),
    ]);

    expect(menu().querySelectorAll(".divider")).toHaveLength(1);
  });
});

describe("staying on screen", () => {
  it("opens where the pointer was", () => {
    measuringAs(208, 300);
    const { menu } = openAt({ x: 120, y: 80 });

    expect(positionOf(menu())).toEqual(["120px", "80px"]);
  });

  it("comes back inside when it would hang off the right or the bottom", () => {
    /*
     * A right-click near the edge is ordinary — that is where you go to paste
     * into empty space. The menu's own size has to come off the limit, which is
     * what the null ref used to make impossible.
     */
    measuringAs(208, 300);
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });

    const { menu } = openAt({ x: 980, y: 690 });

    expect(positionOf(menu())).toEqual(["784px", "392px"]);
  });

  it("measures against the box it is positioned inside, not the window", () => {
    /*
     * The coordinates are relative to the canvas wrapper, so the limit has to be
     * too. Measured against the window instead, a menu opened near the right of a
     * narrower editor pane would be "inside the viewport" and outside its own
     * container — hanging over the properties panel, or clipped by it.
     */
    measuringAs(208, 300);
    const restore = insideABoxOf(600, 400);
    try {
      const { menu } = openAt({ x: 590, y: 390 });

      expect(positionOf(menu())).toEqual(["384px", "92px"]);
    } finally {
      restore();
    }
  });

  it("keeps a margin at the top left rather than touching the edge", () => {
    // A negative position is reachable: the coordinates come from the canvas,
    // which starts above and to the left of the visible area when it is scrolled.
    measuringAs(208, 300);
    const { menu } = openAt({ x: -50, y: -10 });

    expect(positionOf(menu())).toEqual(["8px", "8px"]);
  });

  it("measures again when it is opened somewhere else", () => {
    // The same menu instance is moved for the next right-click rather than
    // remounted, so the adjustment keys off the coordinates.
    measuringAs(208, 300);
    const { menu, rerender } = openAt({ x: 100, y: 100 });

    rerender(
      <ContextMenu x={200} y={150} items={[item("Paste")]} onClose={onClose} />,
    );

    expect(positionOf(menu())).toEqual(["200px", "150px"]);
  });
});

describe("dismissing", () => {
  it("closes on a press anywhere but the menu", () => {
    openAt();

    fireEvent.pointerDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open for a press on the menu itself", () => {
    // The press that lands on an item is a press inside; closing on it would
    // dismiss the menu before the click that follows could choose anything.
    const { menu } = openAt();

    fireEvent.pointerDown(menu());

    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    openAt();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    // The canvas shortcuts keep working while the menu is up; only Escape means
    // "put this away".
    openAt();

    fireEvent.keyDown(window, { key: "v" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes when the canvas is scrolled or zoomed under it", () => {
    // The menu is positioned in canvas coordinates. Left up through a scroll it
    // would point at whatever moved under it.
    openAt();

    fireEvent.wheel(window, { deltaY: 120 });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes all three listeners with it", () => {
    /*
     * They are on `window`, and one of them is in the capture phase. Left behind,
     * every press and every Escape on the board thereafter closes a menu that is
     * already gone — the bug the previous version had with `contextmenu`.
     */
    const { unmount } = openAt();

    unmount();
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.wheel(window, { deltaY: 120 });

    expect(onClose).not.toHaveBeenCalled();
  });
});
