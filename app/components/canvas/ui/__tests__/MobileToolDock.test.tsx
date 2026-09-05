// @vitest-environment jsdom
/**
 * The phone tool dock.
 *
 * A phone's width is the whole constraint. Eleven tools do not fit beside a
 * contextual Style button, so the four geometric shapes collapse into one slot
 * with a picker above it — and that collapsing is where the behaviour is:
 *
 *  - The group button wears the shape you last drew. Snapping back to the
 *    rectangle would make "draw another diamond" a two-tap operation every time.
 *  - The picker closes on a choice, on a tap outside, and on any switch to a
 *    non-shape tool — otherwise it hangs over the canvas you have gone back to
 *    drawing on.
 *  - Style appears only when there is something for it to style: a selection, or
 *    a drawing tool in hand.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MobileToolDock, { type MobileToolDockProps } from "../MobileToolDock";
import { DEFAULT_STYLE } from "../../../../types/shapes";

const show = (overrides: Partial<MobileToolDockProps> = {}) => {
  const props: MobileToolDockProps = {
    tool: "Select",
    onToolChange: vi.fn(),
    style: DEFAULT_STYLE,
    onToggleStyleSheet: vi.fn(),
    isStyleSheetOpen: false,
    hasSelection: false,
    ...overrides,
  };
  const view = render(<MobileToolDock {...props} />);

  /** Change tool the way the editor does — from outside, as a prop. */
  const update = (next: Partial<MobileToolDockProps>) => {
    Object.assign(props, next);
    view.rerender(<MobileToolDock {...props} />);
  };

  return { ...view, props, update };
};

const button = (name: string) => screen.getByRole("button", { name });
const maybe = (name: string) => screen.queryByRole("button", { name });
const picker = () => screen.queryByRole("menu", { name: "Shapes" });
const openPicker = () => fireEvent.click(button("Shapes"));
/** The shape button inside the picker, as against the group button itself. */
const inPicker = (name: string) =>
  screen.getByRole("menu", { name: "Shapes" }).querySelector<HTMLButtonElement>(
    `[aria-label="${name}"]`,
  )!;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the row", () => {
  it("fits every tool a phone needs on one row", () => {
    // Select, the shapes group, and the six others. The count is the point: one
    // more and the row scrolls, which is what the grouping avoids.
    show();

    expect(screen.getAllByRole("button")).toHaveLength(7);
  });

  it("names itself, being the app's primary navigation on a phone", () => {
    show();

    expect(screen.getByRole("navigation", { name: "Drawing tools" })).toBeTruthy();
  });

  it("switches to the tool that was tapped", () => {
    const { props } = show();

    fireEvent.click(button("Draw"));

    expect(props.onToolChange).toHaveBeenCalledWith("Freehand");
  });

  it("shows which tool is in hand", () => {
    show({ tool: "Eraser" });

    expect(button("Eraser").getAttribute("aria-pressed")).toBe("true");
    expect(button("Eraser").getAttribute("data-active")).toBe("true");
    expect(button("Select").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("the shapes group", () => {
  it("stands in for the whole group when one of them is in hand", () => {
    // The group button is pressed for any of the four, so the row still shows
    // what is being drawn even though the shape itself is behind a picker.
    show({ tool: "Diamond" });

    expect(button("Shapes").getAttribute("aria-pressed")).toBe("true");
    expect(button("Shapes").getAttribute("data-active")).toBe("true");
  });

  it("is not pressed while something else is", () => {
    show({ tool: "Text" });

    expect(button("Shapes").getAttribute("aria-pressed")).toBe("false");
  });

  it("opens and closes the picker", () => {
    show();

    openPicker();
    expect(picker()).toBeTruthy();
    expect(button("Shapes").getAttribute("aria-expanded")).toBe("true");

    openPicker();

    expect(picker()).toBeNull();
  });

  it("offers all four shapes", () => {
    show();

    openPicker();

    for (const label of ["Rectangle", "Diamond", "Circle", "Triangle"]) {
      expect(inPicker(label)).toBeTruthy();
    }
  });

  it("picks the shape and puts the picker away", () => {
    // The next tap is on the canvas; a picker still open would swallow it.
    const { props } = show();
    openPicker();

    fireEvent.click(inPicker("Triangle"));

    expect(props.onToolChange).toHaveBeenCalledWith("Triangle");
    expect(picker()).toBeNull();
  });

  it("closes on a tap anywhere else", () => {
    // On touch there is no click-away; something has to cover the rest of the
    // screen for the picker to be dismissible without choosing.
    show();
    openPicker();

    fireEvent.click(button("Close shape picker"));

    expect(picker()).toBeNull();
  });

  it("closes when a non-shape tool is chosen from elsewhere", () => {
    /*
     * The tool can change without the picker being touched — the eraser button
     * beside it, or a shortcut from a paired keyboard. Left open, the picker
     * floats over the canvas being drawn on.
     */
    const { update } = show({ tool: "Square" });
    openPicker();

    update({ tool: "Text" });

    expect(picker()).toBeNull();
  });

  it("stays open while moving between shapes", () => {
    // Changing from square to diamond is still a shape; the picker is where that
    // choice is being made.
    const { update } = show({ tool: "Square" });
    openPicker();

    update({ tool: "Diamond" });

    expect(picker()).toBeTruthy();
  });

  it("wears the shape you are drawing", () => {
    show({ tool: "Circle" });

    // The button's own glyph — the picker is closed, so this is the only icon.
    expect(button("Shapes").querySelectorAll("svg")).toHaveLength(2);
    expect(picker()).toBeNull();
  });

  it("keeps wearing the last shape after you move away from shapes", () => {
    /*
     * Drawing a diamond, then selecting something, then wanting another diamond:
     * if the group snapped back to the rectangle, that would be a tap into the
     * picker every single time.
     */
    const { update, container } = show({ tool: "Diamond" });
    const asDiamond = button("Shapes").innerHTML;

    update({ tool: "Select" });

    expect(button("Shapes").innerHTML).toBe(asDiamond);
    expect(container.querySelector('[aria-label="Shapes"]')).toBeTruthy();
  });

  it("starts on the rectangle, before any shape has been drawn", () => {
    // Nothing has been remembered yet, and the group cannot be blank.
    const { update } = show({ tool: "Select" });
    const atFirst = button("Shapes").innerHTML;

    update({ tool: "Square" });

    expect(button("Shapes").innerHTML).toBe(atFirst);
  });
});

describe("the style button", () => {
  it("stays away while there is nothing to style", () => {
    // Selection tool, nothing selected: a Style button would open a sheet of
    // controls that change nothing.
    show({ tool: "Select", hasSelection: false });

    expect(maybe("Element Properties")).toBeNull();
  });

  it("appears for a selection", () => {
    show({ tool: "Select", hasSelection: true });

    expect(button("Element Properties")).toBeTruthy();
  });

  it("appears for a drawing tool, before anything has been drawn", () => {
    // The style is what the *next* shape will be drawn with, so it is worth
    // reaching for while the tool is in hand.
    show({ tool: "Square", hasSelection: false });

    expect(button("Element Properties")).toBeTruthy();
  });

  it("opens the sheet, and says when it is open", () => {
    const { props, update } = show({ hasSelection: true });

    fireEvent.click(button("Element Properties"));
    expect(props.onToggleStyleSheet).toHaveBeenCalledTimes(1);

    update({ isStyleSheetOpen: true });

    expect(button("Element Properties").getAttribute("aria-pressed")).toBe("true");
    expect(button("Element Properties").getAttribute("data-active")).toBe("true");
  });

  it("shows the current colours in its swatch", () => {
    // The swatch is the readout: it is how you know what the next shape will look
    // like without opening the sheet.
    show({
      hasSelection: true,
      style: { ...DEFAULT_STYLE, fill: "#ffec99", stroke: "#1971c2" },
    });

    const swatch = button("Element Properties").querySelector("span")!;
    expect(swatch.style.backgroundColor).toBe("rgb(255, 236, 153)");
    expect(swatch.style.borderColor).toBe("rgb(25, 113, 194)");
  });

  it("falls back to the stroke colour for an unfilled shape", () => {
    /*
     * Most shapes are drawn unfilled. A transparent swatch would be an empty hole
     * in the dock, and it would say nothing about the colour being drawn with.
     */
    show({
      hasSelection: true,
      style: { ...DEFAULT_STYLE, fill: "transparent", stroke: "#e03131" },
    });

    const swatch = button("Element Properties").querySelector("span")!;
    expect(swatch.style.backgroundColor).toBe("rgb(224, 49, 49)");
  });
});
