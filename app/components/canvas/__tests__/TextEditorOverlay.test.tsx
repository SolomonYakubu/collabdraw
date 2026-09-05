// @vitest-environment jsdom
/**
 * The text editing surface: a transparent `<textarea>` laid over the glyphs the
 * canvas has already drawn.
 *
 * Everything here is either alignment or escape. Alignment, because the textarea
 * is invisible and the canvas is not: if its position, size, font metrics or
 * rotation disagree with the element underneath by even a little, the caret sits
 * beside the letters instead of between them. Escape, because the editor lives
 * inside a canvas whose window-level shortcuts would otherwise treat typing as
 * commands — "d" would switch tools mid-word — and because there are four ways
 * out of editing (Escape, Cmd/Ctrl+Enter, blur, a press anywhere else) and each
 * one has to actually commit.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TextEditorOverlay from "../TextEditorOverlay";
import { createElement } from "../../../services/canvas/elements";
import { BOUND_TEXT_PADDING } from "../../../services/canvas/boundText";
import { getLineHeight } from "../../../services/canvas/textMeasure";
import { DEFAULT_STYLE, type TextShape, type Viewport } from "../../../types/shapes";

const HERE: Viewport = { zoom: 1, scroll: { x: 0, y: 0 } };

const text = (attrs: Record<string, unknown> = {}): TextShape =>
  createElement(
    "Text",
    {
      id: "t1",
      x: 40,
      y: 25,
      text: "hello",
      fontSize: 20,
      fontFamily: "Virgil, sans-serif",
      ...attrs,
    },
    DEFAULT_STYLE.stroke,
    DEFAULT_STYLE,
  ) as TextShape;

const onChange = vi.fn();
const onFinish = vi.fn();

const edit = (
  element: TextShape = text(),
  { viewport = HERE, filter = "none" } = {},
) => {
  const draw = (
    next: TextShape,
    handlers: { finish?: () => void } = {},
  ) => (
    <TextEditorOverlay
      element={next}
      viewport={viewport}
      canvasFilter={filter}
      onChange={onChange}
      onFinish={handlers.finish ?? onFinish}
    />
  );

  const view = render(draw(element));

  /** Swap the element being edited, as clicking into another text does. */
  const editInstead = (next: TextShape, handlers?: { finish?: () => void }) =>
    view.rerender(draw(next, handlers));

  return { ...view, editInstead };
};

const editor = () => screen.getByRole("textbox") as HTMLTextAreaElement;

/** A press somewhere else on the page, which is how a click-away ends editing. */
const pressOutside = (target: Node = document.body) =>
  fireEvent.pointerDown(target);

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("taking over from the canvas", () => {
  it("focuses itself, so the first keystroke is text", () => {
    // Editing is entered by double-click or by typing on a selection; either way
    // the user is already typing by the time this mounts.
    edit();

    expect(document.activeElement).toBe(editor());
  });

  it("puts the caret at the end rather than selecting everything", () => {
    // Clicking into existing text means appending to it. A selected value would
    // be destroyed by the next character.
    edit(text({ text: "hello" }));

    expect(editor().selectionStart).toBe(5);
    expect(editor().selectionEnd).toBe(5);
  });

  it("moves the caret again when a different text is opened", () => {
    // The overlay is reused for the next element, so the caret has to be placed
    // per element and not once per mount.
    const { editInstead } = edit(text({ text: "hello" }));

    editInstead(text({ id: "t2", text: "a longer label" }));

    expect(editor().selectionStart).toBe("a longer label".length);
  });

  it("shows the element's own text, and reports every edit", () => {
    // The scene stays the single source of truth: the textarea is controlled, so
    // a keystroke that is not reported back never appears.
    edit(text({ text: "hello" }));

    fireEvent.change(editor(), { target: { value: "hello there" } });

    expect(onChange).toHaveBeenCalledWith("hello there");
  });
});

describe("keeping the canvas out of it", () => {
  it("stops keystrokes reaching the editor's shortcuts", () => {
    /*
     * `useKeyboardShortcuts` listens on `window`: without this, typing "d" in a
     * label would switch to the diamond tool, and Backspace at the start of a
     * line would delete the shape being labelled.
     */
    const shortcuts = vi.fn();
    window.addEventListener("keydown", shortcuts);
    edit();

    fireEvent.keyDown(editor(), { key: "d" });
    fireEvent.keyDown(editor(), { key: "Backspace" });

    expect(shortcuts).not.toHaveBeenCalled();
    window.removeEventListener("keydown", shortcuts);
  });

  it("swallows the press that places the caret", () => {
    // The press would otherwise reach the canvas underneath and start a new
    // stroke, or drag the element out from under the editor.
    const onCanvas = vi.fn();
    document.addEventListener("pointerdown", onCanvas);
    edit();

    fireEvent.pointerDown(editor());

    expect(onCanvas).not.toHaveBeenCalled();
    document.removeEventListener("pointerdown", onCanvas);
  });

  it("swallows the wheel, so scrolling text does not zoom the board", () => {
    const onCanvasWheel = vi.fn();
    window.addEventListener("wheel", onCanvasWheel);
    edit();

    fireEvent.wheel(editor(), { deltaY: 120 });

    expect(onCanvasWheel).not.toHaveBeenCalled();
    window.removeEventListener("wheel", onCanvasWheel);
  });

  it("leaves the spell checker off", () => {
    // Red underlines are drawn over glyphs the canvas already painted, so they
    // appear only while editing — and only for some of the text.
    edit();

    expect(editor().getAttribute("spellcheck")).toBe("false");
  });
});

describe("ending the edit", () => {
  it("finishes on Escape, without letting Escape clear the selection too", () => {
    edit();

    const event = fireEvent.keyDown(editor(), { key: "Escape" });

    expect(onFinish).toHaveBeenCalledTimes(1);
    // The default was prevented, so the key means only "stop editing".
    expect(event).toBe(false);
  });

  it("finishes on Cmd+Enter and on Ctrl+Enter", () => {
    // Enter alone is a newline in a label, so committing needs the modifier.
    edit();

    fireEvent.keyDown(editor(), { key: "Enter", metaKey: true });
    fireEvent.keyDown(editor(), { key: "Enter", ctrlKey: true });

    expect(onFinish).toHaveBeenCalledTimes(2);
  });

  it("keeps a plain Enter as a newline", () => {
    edit();

    fireEvent.keyDown(editor(), { key: "Enter" });

    expect(onFinish).not.toHaveBeenCalled();
  });

  it("finishes when focus goes elsewhere", () => {
    // Clicking a toolbar button moves focus without a press on the canvas.
    edit();

    fireEvent.blur(editor());

    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("finishes on a press anywhere else on the page", () => {
    edit();
    act(() => void vi.advanceTimersByTime(0));

    pressOutside();

    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("ignores the press that opened it", () => {
    /*
     * The double-click that starts editing is still travelling when this mounts.
     * Listening immediately would close the editor within the same gesture that
     * opened it — the bug this deferral exists for.
     */
    edit();

    pressOutside();

    expect(onFinish).not.toHaveBeenCalled();
  });

  it("does not finish when the press was inside the editor", () => {
    edit();
    act(() => void vi.advanceTimersByTime(0));

    pressOutside(editor());

    expect(onFinish).not.toHaveBeenCalled();
  });

  it("stops listening once editing is over", () => {
    // The listener is on `window` in the capture phase: left behind, it would
    // call `onFinish` for every press on the board thereafter.
    const { unmount } = edit();
    act(() => void vi.advanceTimersByTime(0));

    unmount();
    pressOutside();

    expect(onFinish).not.toHaveBeenCalled();
  });

  it("drops the pending listener when it is unmounted first", () => {
    // Editing can end before the next tick — a remote deletion of the element,
    // for instance. The listener must never be attached at all.
    const { unmount } = edit();

    unmount();
    act(() => void vi.advanceTimersByTime(0));
    pressOutside();

    expect(onFinish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("always reports to the handler it was last given", () => {
    /*
     * The window listener is attached once, on mount, so a handler captured then
     * would go stale — and a stale one commits the text into a scene that has
     * moved on, or into an element that has since been deleted.
     */
    const { editInstead } = edit();
    act(() => void vi.advanceTimersByTime(0));
    const later = vi.fn();

    editInstead(text(), { finish: later });
    pressOutside();

    expect(later).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();
  });
});

describe("sitting exactly over the glyphs", () => {
  it("is placed by the same transform the canvas draws with", () => {
    // `(world + scroll) * zoom`. Any other expression puts the caret next to the
    // letters instead of inside them.
    const viewport: Viewport = { zoom: 2, scroll: { x: 10, y: -5 } };
    edit(text({ x: 40, y: 25 }), { viewport });

    expect(editor().style.left).toBe("100px");
    expect(editor().style.top).toBe("40px");
  });

  it("scales the font and the line height with the zoom", () => {
    // Both, and by the same factor: a line height that does not follow the zoom
    // drifts a full line away by the bottom of a paragraph.
    edit(text({ fontSize: 20 }), {
      viewport: { zoom: 1.5, scroll: { x: 0, y: 0 } },
    });

    expect(editor().style.fontSize).toBe("30px");
    expect(editor().style.lineHeight).toBe(`${getLineHeight(20) * 1.5}px`);
  });

  it("borrows the element's own font, colour and alignment", () => {
    // The textarea's glyphs are invisible, but its wrapping and caret follow the
    // font — and the caret is drawn in the text colour.
    edit(
      text({
        fontFamily: "Virgil, sans-serif",
        stroke: "#1971c2",
        textAlign: "center",
        opacity: 60,
      }),
    );

    expect(editor().style.fontFamily).toBe("Virgil, sans-serif");
    expect(editor().style.color).toBe("rgb(25, 113, 194)");
    expect(editor().style.textAlign).toBe("center");
    expect(editor().style.opacity).toBe("0.6");
    // Left as written: jsdom does not normalise `caret-color`, only `color`.
    expect(editor().style.caretColor).toBe("#1971c2");
  });

  it("wears the canvas's own filter, so the text keeps its colour", () => {
    // Dark mode is a filter over the whole canvas. Without it here, the text
    // would visibly change colour the instant editing began.
    edit(text(), { filter: "invert(93%) hue-rotate(180deg)" });

    expect(editor().style.filter).toBe("invert(93%) hue-rotate(180deg)");
  });

  it("turns with a rotated element", () => {
    // Rotation is stored in radians and CSS wants degrees, about the same centre
    // the canvas rotates around.
    edit(text({ angle: Math.PI / 2 }));

    expect(editor().style.transform).toBe("rotate(90deg)");
    expect(editor().style.transformOrigin).toBe("center center");
  });

  it("leaves an unrotated element untransformed", () => {
    // Not `rotate(0deg)`: a transform of any kind creates a containing block and
    // rounds subpixel positions, which shifts the caret by a fraction.
    edit(text({ angle: 0 }));

    expect(editor().style.transform).toBe("");
  });
});

describe("free text and a label in a box", () => {
  it("lets free text run on one line", () => {
    // Free text grows rightwards as it is typed; wrapping it would disagree with
    // the canvas, which measures the same string unwrapped.
    edit(text({ containerId: null }));

    expect(editor().wrap).toBe("off");
    expect(editor().style.whiteSpace).toBe("pre");
    expect(editor().style.padding).toBe("0px");
  });

  it("wraps a label inside its container's padding", () => {
    // A label is bounded by the shape holding it, and the canvas insets it by
    // the same padding before wrapping.
    edit(text({ containerId: "square-1" }));

    expect(editor().wrap).toBe("soft");
    expect(editor().style.whiteSpace).toBe("pre-wrap");
    expect(editor().style.padding).toBe(`0px ${BOUND_TEXT_PADDING}px`);
  });

  it("scales that padding with the zoom", () => {
    edit(text({ containerId: "square-1" }), {
      viewport: { zoom: 2, scroll: { x: 0, y: 0 } },
    });

    expect(editor().style.padding).toBe(`0px ${BOUND_TEXT_PADDING * 2}px`);
  });

  it("never collapses to nothing on an empty element", () => {
    /*
     * A newly created text has no width or height until something is typed. A
     * zero-sized textarea cannot be clicked into and shows no caret, so it is
     * floored at one character by one line.
     */
    edit(text({ text: "", width: 0, height: 0, fontSize: 20 }));

    expect(editor().style.width).toBe("20px");
    expect(editor().style.height).toBe(`${getLineHeight(20)}px`);
    expect(editor().style.minWidth).toBe("20px");
  });

  it("takes the element's own size once it has one", () => {
    edit(text({ width: 120, height: 48, fontSize: 20 }));

    expect(editor().style.width).toBe("120px");
    expect(editor().style.height).toBe("48px");
  });
});
