// @vitest-environment jsdom
/**
 * The element properties panel.
 *
 * It replaced two separate controls — a toolbar colour popover and a fill modal —
 * that each wrote their own set of rough.js options, one of them with a fresh
 * random hachure angle per click, so re-picking the same colour redrew the shape
 * differently. The fix was to have one panel emit *patches*: every control sends
 * a single key, and the caller merges it into both the selection and the defaults
 * for the next shape. So the contract under test is one key per control — a
 * control that sent a whole style would quietly reset the other nine properties.
 *
 * The rest is which sections are on show. A fill has no pattern while it is
 * transparent, a rectangle has no arrow shape, and there are no actions to
 * perform without a selection; each of those is an absent section rather than a
 * disabled row.
 *
 * Two `Choice` labels collide by design — "Solid" is both a fill pattern and a
 * stroke style — so queries here are scoped to a section rather than global.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import StylePanel, { type StylePanelProps } from "../StylePanel";
import { DEFAULT_STYLE, ROUGHNESS } from "../../../../types/shapes";

const show = (overrides: Partial<StylePanelProps> = {}) => {
  const props: StylePanelProps = {
    style: DEFAULT_STYLE,
    onStyleChange: vi.fn(),
    hasSelection: false,
    showFill: true,
    showEdgeStyle: false,
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onBringToFront: vi.fn(),
    onSendToBack: vi.fn(),
    ...overrides,
  };
  const view = render(<StylePanel {...props} />);
  return { ...view, props };
};

/** The `Section` wrapper holding a given heading, since labels repeat across them. */
const section = (title: string | RegExp) =>
  screen.getByText(title).parentElement as HTMLElement;
const inSection = (title: string | RegExp, name: string) =>
  within(section(title)).getByRole("button", { name }) as HTMLButtonElement;
const heading = (title: string | RegExp) => screen.queryByText(title);
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("every control sends one key", () => {
  /*
   * The patch is merged into the current selection *and* kept as the default for
   * the next shape. A control that sent more than its own key would drag the rest
   * of the panel's state along with it — which is how the old fill modal reset the
   * roughness and the hachure angle each time a colour was picked.
   */
  it.each([
    ["Stroke", "#e03131", { stroke: "#e03131" }],
    ["Background", "#ffec99", { fill: "#ffec99" }],
    ["Stroke width", "4px", { strokeWidth: 4 }],
    ["Stroke style", "Dashed", { strokeStyle: "dashed" }],
    ["Sloppiness", "Cartoonist", { roughness: ROUGHNESS.cartoonist }],
  ])("patches %s from its %s control", (title, control, patch) => {
    const { props } = show();

    fireEvent.click(inSection(title, control));

    expect(props.onStyleChange).toHaveBeenCalledWith(patch);
  });

  it("patches the fill pattern, which is only offered over a fill", () => {
    const { props } = show({ style: { ...DEFAULT_STYLE, fill: "#ffec99" } });

    fireEvent.click(inSection("Fill", "Cross-hatch"));

    expect(props.onStyleChange).toHaveBeenCalledWith({ fillStyle: "cross-hatch" });
  });

  it("patches the arrow shape", () => {
    const { props } = show({ showEdgeStyle: true });

    fireEvent.click(inSection("Arrow shape", "Elbow"));

    expect(props.onStyleChange).toHaveBeenCalledWith({ edgeStyle: "elbow" });
  });

  it("patches the opacity as a number, the slider giving a string", () => {
    // `Number()` on the way out: a string here reaches the renderer and rough.js
    // silently draws nothing for `opacity: "50"`.
    const { props } = show();

    fireEvent.change(field("Opacity"), { target: { value: "50" } });

    expect(props.onStyleChange).toHaveBeenCalledWith({ opacity: 50 });
  });

  it("patches a colour picked outside the five swatches", () => {
    const { props } = show();

    fireEvent.change(field("Custom stroke colour"), { target: { value: "#abcdef" } });
    fireEvent.change(field("Custom background colour"), { target: { value: "#123456" } });

    expect(props.onStyleChange).toHaveBeenNthCalledWith(1, { stroke: "#abcdef" });
    expect(props.onStyleChange).toHaveBeenNthCalledWith(2, { fill: "#123456" });
  });
});

describe("what it shows as chosen", () => {
  it("marks the swatch and the choice that are in force", () => {
    // The panel is the only readout of the current style, so "which of these five"
    // has to be visible at a glance and to a screen reader.
    show({
      style: {
        ...DEFAULT_STYLE,
        stroke: "#1971c2",
        strokeWidth: 4,
        strokeStyle: "dotted",
      },
    });

    expect(inSection("Stroke", "#1971c2").getAttribute("aria-pressed")).toBe("true");
    expect(inSection("Stroke", "#e03131").getAttribute("aria-pressed")).toBe("false");
    expect(inSection("Stroke width", "4px").getAttribute("data-active")).toBe("true");
    expect(inSection("Stroke style", "Dotted").getAttribute("data-active")).toBe("true");
    expect(inSection("Stroke style", "Solid").getAttribute("data-active")).toBeNull();
  });

  it("marks the sloppiness by its value, three levels sharing one scale", () => {
    // The buttons are keyed by label but carry rough.js numbers; matching on the
    // number is what makes "Artist" light up for a shape drawn at 1.
    show({ style: { ...DEFAULT_STYLE, roughness: ROUGHNESS.artist } });

    expect(inSection("Sloppiness", "Artist").getAttribute("aria-pressed")).toBe("true");
    expect(inSection("Sloppiness", "Architect").getAttribute("aria-pressed")).toBe("false");
  });

  it("says how opaque the shape is in words as well as in the slider", () => {
    // A slider thumb is not a readout; the number is in the section heading.
    show({ style: { ...DEFAULT_STYLE, opacity: 60 } });

    expect(heading("Opacity — 60%")).toBeTruthy();
    expect(field("Opacity").value).toBe("60");
    expect(field("Opacity").min).toBe("10");
    expect(field("Opacity").max).toBe("100");
    expect(field("Opacity").step).toBe("10");
  });
});

describe("the transparent swatch", () => {
  it("is offered as a background, and named rather than shown as a hex", () => {
    // A swatch the colour of the panel would look like an empty slot; the red
    // diagonal and the name are what make it a choice.
    show();

    const clear = inSection("Background", "Transparent");
    expect(clear.getAttribute("aria-pressed")).toBe("true");
    expect(clear.querySelector(".bg-red-500")).toBeTruthy();
    expect(clear.getAttribute("title")).toBe("Transparent");
  });

  it("shows white in the custom picker instead of falling back to black", () => {
    /*
     * `<input type="color">` cannot hold "transparent"; given it, the browser
     * sanitises the value to #000000, so an unfilled shape would sit next to a
     * black picker suggesting a black fill.
     */
    show({ style: { ...DEFAULT_STYLE, fill: "transparent" } });

    expect(field("Custom background colour").value).toBe("#ffffff");
  });

  it("shows the fill it has once there is one", () => {
    show({ style: { ...DEFAULT_STYLE, fill: "#a5d8ff" } });

    expect(field("Custom background colour").value).toBe("#a5d8ff");
  });
});

describe("the sections it leaves out", () => {
  it("drops the background entirely for a shape that cannot hold one", () => {
    // A line or a piece of text: a Background section here offers a colour that
    // the renderer would ignore.
    show({ showFill: false });

    expect(heading("Background")).toBeNull();
    expect(heading("Fill")).toBeNull();
    expect(screen.queryByLabelText("Custom background colour")).toBeNull();
    expect(heading("Stroke")).toBeTruthy();
  });

  it("drops the fill pattern while the fill is transparent", () => {
    // There is no hachure to choose the angle of until something is being filled.
    show({ style: { ...DEFAULT_STYLE, fill: "transparent" } });

    expect(heading("Background")).toBeTruthy();
    expect(heading("Fill")).toBeNull();
  });

  it("brings the fill pattern back with a colour", () => {
    show({ style: { ...DEFAULT_STYLE, fill: "#b2f2bb" } });

    expect(within(section("Fill")).getAllByRole("button")).toHaveLength(5);
  });

  it("offers the arrow shape only to arrows and lines", () => {
    const { unmount } = show({ showEdgeStyle: false });
    expect(heading("Arrow shape")).toBeNull();
    unmount();

    show({ showEdgeStyle: true });

    expect(within(section("Arrow shape")).getAllByRole("button")).toHaveLength(3);
  });

  it("offers no actions until something is selected", () => {
    // The panel doubles as the defaults editor for the next shape, and there is
    // nothing to delete or duplicate in that mode.
    show({ hasSelection: false });

    expect(heading("Actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("the actions", () => {
  it("does each one, and teaches its shortcut", () => {
    const { props } = show({ hasSelection: true });

    fireEvent.click(inSection("Actions", "Send to back — Ctrl+Shift+["));
    fireEvent.click(inSection("Actions", "Bring to front — Ctrl+Shift+]"));
    fireEvent.click(inSection("Actions", "Duplicate — Ctrl+D"));
    fireEvent.click(inSection("Actions", "Delete"));

    expect(props.onSendToBack).toHaveBeenCalledTimes(1);
    expect(props.onBringToFront).toHaveBeenCalledTimes(1);
    expect(props.onDuplicate).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(inSection("Actions", "Delete").getAttribute("title")).toBe("Delete — Del");
  });

  it("leaves them all unpressed, being verbs rather than settings", () => {
    // The other `Choice` buttons in the panel are a chosen-one-of-many; these
    // three share the look but must not report themselves as pressed.
    show({ hasSelection: true });

    for (const label of ["Send to back — Ctrl+Shift+[", "Duplicate — Ctrl+D"]) {
      expect(inSection("Actions", label).getAttribute("aria-pressed")).toBe("false");
      expect(inSection("Actions", label).getAttribute("data-active")).toBeNull();
    }
  });
});

describe("as a phone sheet", () => {
  it("gains a titled header with a way out when the caller can close it", () => {
    // On a phone the panel is a sheet over the drawing, so it needs a cross; on
    // the desktop it is docked beside the canvas and cannot be dismissed.
    const onClose = vi.fn();
    show({ onClose });

    expect(screen.getByText("Properties")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close properties" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has no header at all when it is docked", () => {
    show();

    expect(screen.queryByText("Properties")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close properties" })).toBeNull();
  });
});
