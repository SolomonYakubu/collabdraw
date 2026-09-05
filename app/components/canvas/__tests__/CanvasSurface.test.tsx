// @vitest-environment jsdom
/**
 * The two stacked canvases everything is drawn on.
 *
 * The surface itself draws nothing — it owns the backing stores, the frame, and
 * which layer gets what. That division is the whole point, and each half of it
 * has a failure the tests below pin down:
 *
 *  - **The backing store.** Assigning `width` or `height` to a canvas clears it,
 *    so the size is only written when it actually changed; a component that
 *    assigns on every render throws away the last frame each time the pointer
 *    moves.
 *  - **The frame.** Both layers repaint inside one `requestAnimationFrame`, so a
 *    burst of pointer events costs one frame rather than one paint per event —
 *    and the pending frame is cancelled on unmount, since it holds the canvases.
 *  - **The split.** Elements go to the static layer, selection and handles to the
 *    interactive one, and the dark-mode filter to the static layer only: it
 *    inverts what it covers, and inverted selection handles are the wrong colour.
 *
 * `roughjs` and the renderer are faked. What is asserted is the arguments the
 * surface hands them, which is where its own logic ends.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CanvasSurface, { type CanvasSurfaceProps } from "../CanvasSurface";
import { createElement } from "../../../services/canvas/elements";
import type { Shape, Viewport } from "../../../types/shapes";

const roughCanvas = { rough: true };

vi.mock("roughjs", () => ({
  default: { canvas: () => roughCanvas },
}));

vi.mock("../../../services/canvas/renderer", () => ({
  renderStaticScene: vi.fn(),
  renderInteractiveScene: vi.fn(),
}));

const { renderInteractiveScene, renderStaticScene } = await import(
  "../../../services/canvas/renderer"
);

const staticCalls = vi.mocked(renderStaticScene);
const interactiveCalls = vi.mocked(renderInteractiveScene);

/** The frames the surface has asked for, so a test can decide when they run. */
let frames: Array<{ id: number; callback: FrameRequestCallback }>;
let cancelled: Set<number>;
let nextFrameId: number;

const runFrames = () =>
  act(() => {
    const pending = frames;
    frames = [];
    for (const frame of pending) {
      if (!cancelled.has(frame.id)) {
        frame.callback(0);
      }
    }
  });

const HERE: Viewport = { zoom: 1, scroll: { x: 0, y: 0 } };

const box = (id: string): Shape =>
  createElement("Square", { id, x: 0, y: 0, width: 10, height: 10 })!;

const baseProps = (): CanvasSurfaceProps => ({
  size: { width: 800, height: 600 },
  devicePixelRatio: 1,
  viewport: HERE,
  elements: [],
  pendingElement: null,
  erasingIds: new Set<string>(),
  selectedElements: [],
  selectionBounds: null,
  showHandles: false,
  isTransforming: false,
  marquee: null,
  bindingHighlightElement: null,
  alignmentGuides: [],
  eraserTrail: [],
  activeHandle: null,
  snapPoint: null,
  cursor: "default",
  canvasFilter: "none",
  interactiveCanvasRef: { current: null },
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerUp: vi.fn(),
  onPointerCancel: vi.fn(),
  onDoubleClick: vi.fn(),
  onContextMenu: vi.fn(),
});

const draw = (overrides: Partial<CanvasSurfaceProps> = {}) => {
  const props = { ...baseProps(), ...overrides };
  const view = render(<CanvasSurface {...props} />);

  const canvases = () =>
    Array.from(view.container.querySelectorAll("canvas")) as HTMLCanvasElement[];

  /** Change some props without remounting, as any pointer move does. */
  const update = (next: Partial<CanvasSurfaceProps>) => {
    Object.assign(props, next);
    view.rerender(<CanvasSurface {...props} />);
  };

  return { ...view, props, update, canvases };
};

/**
 * Record assignments to a canvas's backing size. Every assignment clears the
 * canvas, whether or not the value changed, which is what makes them countable
 * evidence rather than a detail.
 */
const watchBackingSize = (canvas: HTMLCanvasElement) => {
  const assigned: Array<[string, number]> = [];

  for (const property of ["width", "height"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      property,
    )!;
    Object.defineProperty(canvas, property, {
      configurable: true,
      get: () => descriptor.get!.call(canvas),
      set: (value: number) => {
        assigned.push([property, value]);
        descriptor.set!.call(canvas, value);
      },
    });
  }

  return assigned;
};

beforeEach(() => {
  frames = [];
  cancelled = new Set();
  nextFrameId = 1;

  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.push({ id, callback });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    cancelled.add(id);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the backing store", () => {
  it("is sized in device pixels, not CSS pixels", () => {
    // The canvas is laid out in CSS pixels and drawn in device pixels; sizing it
    // in CSS pixels is how a drawing comes out soft on a retina screen.
    const { canvases } = draw({
      size: { width: 800, height: 600 },
      devicePixelRatio: 2,
    });

    for (const canvas of canvases()) {
      expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
      expect([canvas.style.width, canvas.style.height]).toEqual([
        "800px",
        "600px",
      ]);
    }
  });

  it("rounds a fractional ratio down to whole pixels", () => {
    // 1.5 and 2.25 are real values on Windows displays. A fractional backing
    // store is rejected outright by some browsers.
    const { canvases } = draw({
      size: { width: 801, height: 601 },
      devicePixelRatio: 1.5,
    });

    expect([canvases()[0].width, canvases()[0].height]).toEqual([1201, 901]);
  });

  it("never asks for a canvas of no size", () => {
    // The surface is measured before layout has settled, and a 0×0 canvas throws
    // when a context is taken from it.
    const { canvases } = draw({ size: { width: 0, height: 0 } });

    expect([canvases()[0].width, canvases()[0].height]).toEqual([1, 1]);
  });

  it("leaves the size alone when nothing about it changed", () => {
    /*
     * This is the one that matters: a re-render for any other reason — a pointer
     * move, a selection change — must not touch `width`, because assigning it
     * blanks the last painted frame and the drawing flickers.
     */
    const { canvases, update } = draw();
    const assignments = watchBackingSize(canvases()[0]);

    update({ cursor: "crosshair", selectedElements: [box("a")] });

    expect(assignments).toEqual([]);
  });

  it("resizes when the window does", () => {
    // The pair is written together once either half has moved — there is no
    // saving in writing one of them, since the frame is already gone.
    const { canvases, update } = draw();
    const assignments = watchBackingSize(canvases()[0]);

    update({ size: { width: 900, height: 600 } });

    expect(assignments).toEqual([
      ["width", 900],
      ["height", 600],
    ]);
  });

  it("resizes when the display's pixel ratio changes", () => {
    // Dragging the window to a second monitor changes the ratio without changing
    // the CSS size.
    const { canvases, update } = draw();
    const assignments = watchBackingSize(canvases()[0]);

    update({ devicePixelRatio: 2 });

    expect(assignments).toEqual([
      ["width", 1600],
      ["height", 1200],
    ]);
  });
});

describe("the frame", () => {
  it("paints nothing until the frame runs", () => {
    // Painting during the effect would block the commit; the surface asks for a
    // frame and yields.
    draw({ elements: [box("a")] });

    expect(staticCalls).not.toHaveBeenCalled();
    expect(interactiveCalls).not.toHaveBeenCalled();
  });

  it("paints both layers when it does", () => {
    draw({ elements: [box("a")] });

    runFrames();

    expect(staticCalls).toHaveBeenCalledTimes(1);
    expect(interactiveCalls).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of changes into one paint", () => {
    /*
     * A drag emits a pointer move per frame at best and several per frame at
     * worst. Each one re-renders; without the cancel, each one also paints, and
     * the scene is generated two or three times for a single visible frame.
     *
     * The cancel that does the work is the effect's cleanup, which React runs
     * before the effect body — so the body's own `frameRef.current !== null`
     * guard never fires, and the coalescing lives entirely in the cleanup.
     */
    const { update } = draw();

    update({ viewport: { zoom: 1.1, scroll: { x: 0, y: 0 } } });
    update({ viewport: { zoom: 1.2, scroll: { x: 0, y: 0 } } });
    update({ viewport: { zoom: 1.3, scroll: { x: 0, y: 0 } } });
    runFrames();

    expect(staticCalls).toHaveBeenCalledTimes(1);
    // And what it painted is the newest state, not the first.
    expect(staticCalls.mock.calls[0][0].viewport.zoom).toBe(1.3);
  });

  it("paints again on the next change, once the frame has run", () => {
    // The frame handle is cleared as the frame runs; if it were not, the next
    // change would cancel a frame that had already happened and never repaint.
    const { update } = draw();
    runFrames();

    update({ elements: [box("a")] });
    runFrames();

    expect(staticCalls).toHaveBeenCalledTimes(2);
  });

  it("drops the frame it was holding when the board closes", () => {
    // The callback closes over both canvases and the whole scene. Left to run
    // after unmount it paints into a detached canvas, keeping it alive.
    const { unmount } = draw({ elements: [box("a")] });

    unmount();
    runFrames();

    expect(staticCalls).not.toHaveBeenCalled();
  });
});

describe("which layer gets what", () => {
  it("gives the elements to the static layer", () => {
    const elements = [box("a"), box("b")];
    const pendingElement = box("pending");
    const erasingIds = new Set(["a"]);
    draw({
      elements,
      pendingElement,
      erasingIds,
      devicePixelRatio: 2,
      viewport: { zoom: 1.5, scroll: { x: 5, y: -5 } },
    });

    runFrames();

    const scene = staticCalls.mock.calls[0][0];
    expect(scene.elements).toBe(elements);
    expect(scene.pendingElement).toBe(pendingElement);
    expect(scene.erasingIds).toBe(erasingIds);
    expect(scene.devicePixelRatio).toBe(2);
    expect(scene.viewport).toEqual({ zoom: 1.5, scroll: { x: 5, y: -5 } });
    expect(scene.roughCanvas).toBe(roughCanvas);
  });

  it("gives the selection and the guides to the interactive layer", () => {
    // None of this is part of the drawing, and all of it changes on hover; it is
    // on its own layer so that a hover never re-generates element geometry.
    const selectedElements = [box("a")];
    const selectionBounds = { x: 0, y: 0, width: 10, height: 10 };
    const marquee = { x: 1, y: 2, width: 3, height: 4 };
    const bindingHighlightElement = box("b");
    const alignmentGuides = [
      { orientation: "vertical" as const, position: 4, from: 0, to: 10 },
    ];
    const eraserTrail = [{ x: 1, y: 1 }];
    const snapPoint = { x: 2, y: 2 };
    draw({
      selectedElements,
      selectionBounds,
      marquee,
      bindingHighlightElement,
      alignmentGuides,
      eraserTrail,
      snapPoint,
      showHandles: true,
      isTransforming: true,
    });

    runFrames();

    const overlay = interactiveCalls.mock.calls[0][0];
    expect(overlay.selectedElements).toBe(selectedElements);
    expect(overlay.selectionBounds).toBe(selectionBounds);
    expect(overlay.marquee).toBe(marquee);
    expect(overlay.bindingHighlightElement).toBe(bindingHighlightElement);
    expect(overlay.alignmentGuides).toBe(alignmentGuides);
    expect(overlay.eraserTrail).toBe(eraserTrail);
    expect(overlay.snapPoint).toBe(snapPoint);
    expect(overlay.showHandles).toBe(true);
    expect(overlay.isTransforming).toBe(true);
  });

  it("paints each layer onto its own canvas", () => {
    const { canvases } = draw();

    runFrames();

    const [staticCanvas, interactiveCanvas] = canvases();
    expect(staticCalls.mock.calls[0][0].canvas).toBe(staticCanvas);
    expect(interactiveCalls.mock.calls[0][0].canvas).toBe(interactiveCanvas);
  });

  it("filters the elements only, so handles keep their colours", () => {
    /*
     * Dark mode is an inversion over the element layer. Applied to the whole
     * surface it would invert the selection outline and the transform handles
     * too, which are drawn in colours chosen for the dark theme already.
     */
    const { canvases } = draw({ canvasFilter: "invert(93%) hue-rotate(180deg)" });

    const [staticCanvas, interactiveCanvas] = canvases();
    expect(staticCanvas.style.filter).toBe("invert(93%) hue-rotate(180deg)");
    expect(interactiveCanvas.style.filter).toBe("");
  });
});

describe("the pointer target", () => {
  it("is the top canvas, and it is the one the caller was given a ref to", () => {
    // The interaction hook measures this element and takes pointer capture on
    // it; a ref to the wrong layer means every coordinate is computed from a
    // canvas that is not the one being pressed.
    const interactiveCanvasRef: React.RefObject<HTMLCanvasElement | null> = {
      current: null,
    };
    const { canvases } = draw({ interactiveCanvasRef });

    expect(interactiveCanvasRef.current).toBe(canvases()[1]);
  });

  it("reports every gesture the editor acts on", () => {
    const props = baseProps();
    const { container } = render(<CanvasSurface {...props} />);
    const target = container.querySelectorAll("canvas")[1];

    target.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }),
    );
    target.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1 }),
    );
    target.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
    );
    target.dispatchEvent(
      new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }),
    );
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect(props.onPointerDown).toHaveBeenCalledTimes(1);
    expect(props.onPointerMove).toHaveBeenCalledTimes(1);
    expect(props.onPointerUp).toHaveBeenCalledTimes(1);
    expect(props.onPointerCancel).toHaveBeenCalledTimes(1);
    expect(props.onDoubleClick).toHaveBeenCalledTimes(1);
    expect(props.onContextMenu).toHaveBeenCalledTimes(1);
  });

  it("wears the cursor the current tool asked for", () => {
    // The cursor belongs on the layer that receives the pointer, and it changes
    // on hover; the static layer must not re-render for it.
    const { canvases } = draw({ cursor: "crosshair" });

    expect(canvases()[1].style.cursor).toBe("crosshair");
  });

  it("keeps the browser's own touch gestures off both layers", () => {
    // Without this, a two-finger pan scrolls the page instead of the board, and
    // a drag on a phone selects the page rather than drawing.
    const { canvases } = draw();

    for (const canvas of canvases()) {
      expect(canvas.style.touchAction).toBe("none");
    }
  });
});
