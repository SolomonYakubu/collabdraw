// @vitest-environment jsdom
/**
 * Keyboard shortcuts: one window-level listener that has to decide, per key,
 * between the canvas, the browser and whatever the user is typing into.
 *
 * The failures are all about that arbitration. A shortcut that fires while the
 * user is typing renames a board and then deletes their selection with the same
 * keystroke; a missing `preventDefault` lets `Backspace` navigate the page away
 * mid-drawing and the arrow keys scroll the canvas out of view; and a `Meta`
 * combination the editor does not use has to reach the browser intact, or Save
 * and Print stop working on the page.
 */
import { useRef } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TOOL_SHORTCUTS,
  useKeyboardShortcuts,
  type KeyboardCallbacks,
} from "../useKeyboardShortcuts";

type Api = { [K in keyof KeyboardCallbacks]: ReturnType<typeof vi.fn> };

let api: Api;
let editingText: boolean;
let spacePressed: { current: boolean };

const makeApi = (): Api => ({
  setTool: vi.fn(),
  toggleToolLock: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  deleteSelection: vi.fn(),
  selectAll: vi.fn(),
  duplicateSelection: vi.fn(),
  nudgeSelection: vi.fn(),
  copySelection: vi.fn(),
  cutSelection: vi.fn(),
  paste: vi.fn(),
  bringForward: vi.fn(),
  sendBackward: vi.fn(),
  bringToFront: vi.fn(),
  sendToBack: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  resetZoom: vi.fn(),
  zoomToFit: vi.fn(),
  escape: vi.fn(),
  isEditingText: vi.fn(() => editingText),
});

const mount = () =>
  renderHook(() => {
    const ref = useRef(spacePressed).current;
    useKeyboardShortcuts(api as unknown as KeyboardCallbacks, ref);
  });

/** Dispatches a real event, so `defaultPrevented` is the browser's own answer. */
const press = (
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = window,
): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
};

/** An element that swallows shortcuts, mounted in the document as a real focus would be. */
const typingTarget = (tag: "input" | "textarea" | "select"): HTMLElement => {
  const element = document.createElement(tag);
  document.body.append(element);
  return element;
};

beforeEach(() => {
  api = makeApi();
  editingText = false;
  spacePressed = { current: false };
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("keys the editor must not take", () => {
  it.each(["input", "textarea", "select"] as const)(
    "ignores everything typed into a %s",
    (tag) => {
      mount();

      const event = press("r", {}, typingTarget(tag));

      expect(api.setTool).not.toHaveBeenCalled();
      // Not prevented either: the field's own handling has to go ahead.
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it("ignores a contenteditable element, whatever its tag", () => {
    mount();
    const element = document.createElement("div");
    element.contentEditable = "true";
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(element, "isContentEditable", { value: true });
    document.body.append(element);

    press("Backspace", {}, element);

    expect(api.deleteSelection).not.toHaveBeenCalled();
  });

  it("suppresses shortcuts while a canvas text editor is open", () => {
    /*
     * The text editor is a canvas overlay, not an input, so the target check
     * cannot see it — without `isEditingText` a `Backspace` mid-sentence would
     * delete the element being typed into.
     */
    editingText = true;
    mount();

    press("Backspace");
    press("r");

    expect(api.deleteSelection).not.toHaveBeenCalled();
    expect(api.setTool).not.toHaveBeenCalled();
  });

  it("lets a browser combination the editor does not use through untouched", () => {
    // Meta+S must still reach Save, or the page's own shortcuts stop working.
    mount();

    const event = press("s", { metaKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it("does not prevent the clipboard keys, which need the native event", () => {
    // The clipboard handlers read `event.clipboardData` from the paste/copy
    // event the browser raises next; preventing the keydown cancels it.
    mount();

    for (const key of ["c", "x", "v"]) {
      expect(press(key, { metaKey: true }).defaultPrevented).toBe(false);
    }

    expect(api.copySelection).toHaveBeenCalledTimes(1);
    expect(api.cutSelection).toHaveBeenCalledTimes(1);
    expect(api.paste).toHaveBeenCalledTimes(1);
  });
});

describe("hold space to pan", () => {
  it("marks space down and stops the page scrolling", () => {
    mount();

    const event = press(" ");

    expect(spacePressed.current).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("releases on keyup", () => {
    mount();
    press(" ");

    window.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));

    expect(spacePressed.current).toBe(false);
  });

  it("leaves other keys' keyup alone", () => {
    mount();
    press(" ");

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "r" }));

    expect(spacePressed.current).toBe(true);
  });

  it("releases when the window loses focus mid-pan", () => {
    // Alt-tabbing away while panning would otherwise leave space stuck down, and
    // the next click would pan instead of drawing.
    mount();
    press(" ");

    window.dispatchEvent(new Event("blur"));

    expect(spacePressed.current).toBe(false);
  });

  it("is a plain space when typed into a field", () => {
    mount();

    const event = press(" ", {}, typingTarget("input"));

    expect(spacePressed.current).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("modifier shortcuts", () => {
  const cases: Array<[string, KeyboardEventInit, keyof Api]> = [
    ["z", {}, "undo"],
    ["z", { shiftKey: true }, "redo"],
    ["y", {}, "redo"],
    ["a", {}, "selectAll"],
    ["d", {}, "duplicateSelection"],
    ["]", {}, "bringForward"],
    ["]", { shiftKey: true }, "bringToFront"],
    ["[", {}, "sendBackward"],
    ["[", { shiftKey: true }, "sendToBack"],
    ["=", {}, "zoomIn"],
    ["+", {}, "zoomIn"],
    ["-", {}, "zoomOut"],
    ["0", {}, "resetZoom"],
  ];

  it.each(cases)("meta+%s%s runs %s", (key, init, method) => {
    mount();

    const event = press(key, { ...init, metaKey: true });

    expect(api[method]).toHaveBeenCalledTimes(1);
    // These all shadow a browser default — zoom, select-all, bookmark.
    expect(event.defaultPrevented).toBe(true);
  });

  it("takes ctrl as well as meta, so the bindings work on every platform", () => {
    mount();

    press("z", { ctrlKey: true });

    expect(api.undo).toHaveBeenCalledTimes(1);
  });

  it("matches the letter whatever the shift key did to its case", () => {
    // Shift+Meta+Z arrives as "Z"; a case-sensitive compare would drop redo.
    mount();

    press("Z", { metaKey: true, shiftKey: true });

    expect(api.redo).toHaveBeenCalledTimes(1);
    expect(api.undo).not.toHaveBeenCalled();
  });

  it("zooms to fit on shift+1", () => {
    mount();

    const event = press("!", { shiftKey: true });

    expect(api.zoomToFit).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("editing keys", () => {
  it("cancels the current gesture on escape", () => {
    mount();

    const event = press("Escape");

    expect(api.escape).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(["Delete", "Backspace"])("deletes the selection on %s", (key) => {
    mount();

    const event = press(key);

    expect(api.deleteSelection).toHaveBeenCalledTimes(1);
    // Unprevented, `Backspace` navigates the page back and the drawing is gone.
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["ArrowLeft", [-1, 0]],
    ["ArrowRight", [1, 0]],
    ["ArrowUp", [0, -1]],
    ["ArrowDown", [0, 1]],
  ] as const)("nudges one unit on %s", (key, [dx, dy]) => {
    mount();

    const event = press(key);

    expect(api.nudgeSelection).toHaveBeenCalledWith(dx, dy);
    // Otherwise the page scrolls and the canvas leaves the viewport.
    expect(event.defaultPrevented).toBe(true);
  });

  it("nudges twenty units with shift held", () => {
    mount();

    press("ArrowRight", { shiftKey: true });

    expect(api.nudgeSelection).toHaveBeenCalledWith(20, 0);
  });
});

describe("tool keys", () => {
  it("switches to every tool by each of its keys", () => {
    // The table is also what the toolbar renders its hints from, so a key that
    // moved would show one thing and do another.
    mount();

    for (const { tool, keys } of TOOL_SHORTCUTS) {
      for (const key of keys) {
        api.setTool.mockClear();
        const event = press(key);
        expect(api.setTool).toHaveBeenCalledWith(tool);
        expect(event.defaultPrevented).toBe(true);
      }
    }
  });

  it("takes an uppercase letter too", () => {
    // Caps lock on, or shift released a moment late.
    mount();

    press("R");

    expect(api.setTool).toHaveBeenCalledWith("Square");
  });

  it("keeps the tool on q", () => {
    mount();

    const event = press("q");

    expect(api.toggleToolLock).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a shifted tool key alone", () => {
    // Shift is reserved for the shifted bindings; treating Shift+R as R would
    // switch tools out from under a shift-constrained gesture.
    mount();

    press("r", { shiftKey: true });
    press("q", { shiftKey: true });

    expect(api.setTool).not.toHaveBeenCalled();
    expect(api.toggleToolLock).not.toHaveBeenCalled();
  });

  it("ignores a key that is not bound to anything", () => {
    mount();

    const event = press("k");

    expect(event.defaultPrevented).toBe(false);
    for (const fn of Object.values(api)) {
      if (fn !== api.isEditingText) {
        expect(fn).not.toHaveBeenCalled();
      }
    }
  });
});

describe("the listener's lifetime", () => {
  it("stops listening once unmounted", () => {
    // The listener is on `window`, which outlives the canvas; a leaked one would
    // keep driving a scene that is no longer on screen.
    const { unmount } = mount();
    unmount();

    press("r");

    expect(api.setTool).not.toHaveBeenCalled();
  });

  it("calls the callbacks from the latest render", () => {
    /*
     * The effect subscribes once, so it closes over the first render's callbacks
     * — every one of which is rebuilt whenever the scene changes. Without the ref
     * mirror, `undo` would run against the scene as it was on mount.
     */
    const { rerender } = renderHook(
      ({ callbacks }: { callbacks: Api }) => {
        const ref = useRef(spacePressed).current;
        useKeyboardShortcuts(callbacks as unknown as KeyboardCallbacks, ref);
      },
      { initialProps: { callbacks: api } },
    );

    const replacement = makeApi();
    rerender({ callbacks: replacement });
    press("r");

    expect(api.setTool).not.toHaveBeenCalled();
    expect(replacement.setTool).toHaveBeenCalledWith("Square");
  });
});
