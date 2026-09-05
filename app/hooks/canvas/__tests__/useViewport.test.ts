// @vitest-environment jsdom
/**
 * Pan, zoom and canvas sizing.
 *
 * Two bugs live in this hook's history and both are pinned below. The wheel
 * listener is attached natively with `{ passive: false }`, because React's
 * synthetic `onWheel` is passive and the `preventDefault()` inside it was
 * ignored — the page scrolled away underneath the canvas while you zoomed. And
 * the container is measured with a `ResizeObserver` rather than from props, so
 * the canvas follows a sidebar opening or a window resize instead of keeping
 * whatever size it had when it mounted.
 *
 * The zoom maths itself is `utils/__tests__/viewport.test.ts`; what matters here
 * is that the hook anchors each gesture at the right point — the cursor for a
 * wheel, the viewport centre for the buttons — and that `viewportRef` is always
 * current, since every pointer handler reads the viewport from it.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useViewport } from "../useViewport";
import { MAX_ZOOM, MIN_ZOOM } from "../../../types/shapes";
import { screenToWorld } from "../../../utils/viewport";

/** The observers created during a test, so one can be fired by hand. */
let observers: Array<{ callback: () => void; disconnected: boolean }>;
/** The media queries created during a test, keyed in creation order. */
let queries: Array<{ listeners: Set<() => void> }>;
let container: HTMLDivElement;
let rect: { width: number; height: number };

const CONTAINER_SIZE = { width: 800, height: 600 };

beforeEach(() => {
  observers = [];
  queries = [];
  rect = { ...CONTAINER_SIZE };

  container = document.createElement("div");
  document.body.append(container);
  // jsdom lays nothing out, so the size has to be dictated.
  container.getBoundingClientRect = () =>
    ({ left: 0, top: 0, ...rect }) as DOMRect;

  class ResizeObserverStub {
    private entry: { callback: () => void; disconnected: boolean };

    constructor(callback: () => void) {
      this.entry = { callback, disconnected: false };
      observers.push(this.entry);
    }

    observe() {}

    disconnect() {
      this.entry.disconnected = true;
    }
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  window.devicePixelRatio = 1;
  vi.stubGlobal("matchMedia", (): MediaQueryList => {
    const listeners = new Set<() => void>();
    queries.push({ listeners });
    return {
      matches: false,
      addEventListener: (_: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) =>
        listeners.delete(listener),
    } as unknown as MediaQueryList;
  });
});

afterEach(() => {
  cleanup();
  container.remove();
  vi.unstubAllGlobals();
});

const setup = (initialViewport?: Parameters<typeof useViewport>[1]) =>
  renderHook(() => useViewport({ current: container }, initialViewport));

/** A cancelable wheel event, as the browser sends it. */
const wheel = (init: WheelEventInit) =>
  new WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });

describe("initial state", () => {
  it("starts unscrolled at 1:1", () => {
    const { result } = setup();

    expect(result.current.viewport).toEqual({ zoom: 1, scroll: { x: 0, y: 0 } });
  });

  it("adopts a restored pan and zoom", () => {
    // A saved board or a local scene comes back with the view the user left.
    const restored = { zoom: 2.5, scroll: { x: -120, y: 40 } };
    const { result } = setup(restored);

    expect(result.current.viewport).toEqual(restored);
  });

  it("falls back to the default when the restored viewport is null", () => {
    const { result } = setup(null);

    expect(result.current.viewport.zoom).toBe(1);
  });

  it("keeps the ref in step with the state", () => {
    // Pointer handlers read the viewport from the ref, so a stale one puts every
    // press at the wrong world coordinates.
    const { result } = setup();

    act(() => result.current.scrollBy(100, 0));

    expect(result.current.viewportRef.current).toBe(result.current.viewport);
  });
});

describe("sizing", () => {
  it("measures the container on mount", () => {
    const { result } = setup();

    expect(result.current.size).toEqual(CONTAINER_SIZE);
  });

  it("re-measures when the container itself changes size", () => {
    /*
     * The bug: the old code only re-measured when the `width`/`height` props
     * changed, so opening a panel beside the canvas left it at its old size and
     * everything drawn afterwards was offset.
     */
    const { result } = setup();

    rect = { width: 500, height: 400 };
    act(() => observers[0].callback());

    expect(result.current.size).toEqual({ width: 500, height: 400 });
  });

  it("keeps the same size object when the measurement has not moved", () => {
    // The observer fires for changes that do not alter the CSS box; a fresh
    // object each time would re-render the whole canvas for nothing.
    const { result } = setup();
    const first = result.current.size;

    act(() => observers[0].callback());

    expect(result.current.size).toBe(first);
  });

  it("stops observing when it unmounts", () => {
    const { unmount } = setup();

    unmount();

    expect(observers[0].disconnected).toBe(true);
  });

  it("does nothing at all without a container", () => {
    // The first render happens before the ref is attached.
    const { result } = renderHook(() => useViewport({ current: null }));

    expect(result.current.size).toEqual({ width: 0, height: 0 });
    expect(observers).toEqual([]);
  });
});

describe("device pixel ratio", () => {
  it("reports the ratio the display has", () => {
    window.devicePixelRatio = 2;
    const { result } = setup();

    expect(result.current.devicePixelRatio).toBe(2);
  });

  it("follows the ratio when the window moves to another display", () => {
    // The renderer scales its backing store by this; left stale, a canvas
    // dragged onto a retina display stays blurry until something else re-renders.
    const { result } = setup();

    window.devicePixelRatio = 3;
    act(() => window.dispatchEvent(new Event("resize")));

    expect(result.current.devicePixelRatio).toBe(3);
  });

  it("follows a resolution change with no resize event", () => {
    // Browser zoom changes the ratio without resizing the window.
    const { result } = setup();

    window.devicePixelRatio = 1.5;
    act(() => queries[0].listeners.forEach((listener) => listener()));

    expect(result.current.devicePixelRatio).toBe(1.5);
  });

  it("treats a missing ratio as 1:1", () => {
    window.devicePixelRatio = 0;
    const { result } = setup();

    expect(result.current.devicePixelRatio).toBe(1);
  });
});

describe("wheel", () => {
  it("stops the page scrolling underneath the canvas", () => {
    /*
     * The listener is registered natively with `{ passive: false }`. React's
     * synthetic `onWheel` is passive, which is why the `preventDefault()` that
     * used to live in it did nothing at all.
     */
    setup();
    const event = wheel({ deltaY: 100 });

    act(() => {
      container.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  it("zooms about the cursor with ctrl held", () => {
    // Pinch on a trackpad arrives as ctrl+wheel. The world point under the
    // cursor has to stay under it, or the canvas slides away as you zoom.
    const { result } = setup();
    const anchor = { x: 200, y: 150 };
    const before = screenToWorld(anchor.x, anchor.y, result.current.viewport);

    act(() => {
      container.dispatchEvent(
        wheel({ deltaY: -100, ctrlKey: true, clientX: anchor.x, clientY: anchor.y }),
      );
    });

    expect(result.current.viewport.zoom).toBeCloseTo(Math.E);
    const after = screenToWorld(anchor.x, anchor.y, result.current.viewport);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("zooms with cmd too, for the mac shortcut", () => {
    const { result } = setup();

    act(() => {
      container.dispatchEvent(wheel({ deltaY: -100, metaKey: true }));
    });

    expect(result.current.viewport.zoom).toBeGreaterThan(1);
  });

  it("measures the cursor from the container, not the page", () => {
    // The canvas is rarely at the top-left of the document; using the client
    // position raw would anchor the zoom somewhere off to the side.
    container.getBoundingClientRect = () =>
      ({ left: 300, top: 100, ...rect }) as DOMRect;
    const { result } = setup();
    const before = screenToWorld(50, 50, result.current.viewport);

    act(() => {
      container.dispatchEvent(
        wheel({ deltaY: -100, ctrlKey: true, clientX: 350, clientY: 150 }),
      );
    });

    const after = screenToWorld(50, 50, result.current.viewport);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("scrolls without a modifier, in world units", () => {
    const { result } = setup({ zoom: 2, scroll: { x: 0, y: 0 } });

    act(() => {
      container.dispatchEvent(wheel({ deltaX: 40, deltaY: 60 }));
    });

    // Halved by the zoom: a wheel notch covers the same distance on screen
    // however far in you are.
    expect(result.current.viewport.scroll).toEqual({ x: -20, y: -30 });
    expect(result.current.viewport.zoom).toBe(2);
  });

  it("turns a vertical wheel sideways with shift", () => {
    // The only way to pan horizontally with a mouse that has one wheel.
    const { result } = setup();

    act(() => {
      container.dispatchEvent(wheel({ deltaY: 60, shiftKey: true }));
    });

    expect(result.current.viewport.scroll).toEqual({ x: -60, y: 0 });
  });

  it("stops listening when it unmounts", () => {
    const { unmount } = setup();
    unmount();

    const event = wheel({ deltaY: 100 });
    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});

describe("zoom controls", () => {
  it("zooms in and out about the centre of the canvas", () => {
    const { result } = setup();
    const centre = { x: CONTAINER_SIZE.width / 2, y: CONTAINER_SIZE.height / 2 };
    const before = screenToWorld(centre.x, centre.y, result.current.viewport);

    act(() => result.current.zoomIn());

    expect(result.current.viewport.zoom).toBeCloseTo(1.1);
    const after = screenToWorld(centre.x, centre.y, result.current.viewport);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("comes back to where it started after out and in", () => {
    const { result } = setup();

    act(() => result.current.zoomOut());
    expect(result.current.viewport.zoom).toBeCloseTo(1 / 1.1);

    act(() => result.current.zoomIn());
    expect(result.current.viewport.zoom).toBeCloseTo(1);
    expect(result.current.viewport.scroll.x).toBeCloseTo(0);
    expect(result.current.viewport.scroll.y).toBeCloseTo(0);
  });

  it("resets to 1:1 while keeping the centre of the view", () => {
    // Reset is not "go home": what is in the middle of the screen stays there.
    const { result } = setup({ zoom: 4, scroll: { x: -100, y: -50 } });
    const centre = { x: CONTAINER_SIZE.width / 2, y: CONTAINER_SIZE.height / 2 };
    const before = screenToWorld(centre.x, centre.y, result.current.viewport);

    act(() => result.current.resetZoom());

    expect(result.current.viewport.zoom).toBe(1);
    const after = screenToWorld(centre.x, centre.y, result.current.viewport);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("will not zoom past the limits", () => {
    const { result } = setup({ zoom: MAX_ZOOM, scroll: { x: 0, y: 0 } });

    act(() => result.current.zoomIn());
    expect(result.current.viewport.zoom).toBe(MAX_ZOOM);

    act(() => result.current.setViewport({ zoom: MIN_ZOOM, scroll: { x: 0, y: 0 } }));
    act(() => result.current.zoomOut());
    expect(result.current.viewport.zoom).toBe(MIN_ZOOM);
  });

  it("uses the size it was last measured at", () => {
    // The controls are memoised once, so they read the size from a ref; a
    // captured one would zoom about the centre the canvas had on mount.
    const { result } = setup();
    rect = { width: 400, height: 400 };
    act(() => observers[0].callback());

    act(() => result.current.resetZoom());
    act(() => result.current.setViewport({ zoom: 2, scroll: { x: 0, y: 0 } }));
    const centre = { x: 200, y: 200 };
    const before = screenToWorld(centre.x, centre.y, result.current.viewport);

    act(() => result.current.zoomIn());

    const after = screenToWorld(centre.x, centre.y, result.current.viewport);
    expect(after.x).toBeCloseTo(before.x);
  });
});

describe("zoomToFit", () => {
  it("centres a box and zooms out far enough to hold it", () => {
    const { result } = setup();

    act(() => result.current.zoomToFit({ x: 0, y: 0, width: 2000, height: 1000 }));

    // 2000 wide into 800 less a 64px margin either side.
    expect(result.current.viewport.zoom).toBeCloseTo((800 - 128) / 2000);
    const centre = screenToWorld(
      CONTAINER_SIZE.width / 2,
      CONTAINER_SIZE.height / 2,
      result.current.viewport,
    );
    expect(centre.x).toBeCloseTo(1000);
    expect(centre.y).toBeCloseTo(500);
  });

  it("never zooms in to fit something small", () => {
    // Fitting a single small shape to the screen would blow it up to fill the
    // canvas, which is disorienting rather than helpful.
    const { result } = setup();

    act(() => result.current.zoomToFit({ x: 0, y: 0, width: 10, height: 10 }));

    expect(result.current.viewport.zoom).toBe(1);
  });

  it("goes back to the default view for an empty canvas", () => {
    const { result } = setup({ zoom: 3, scroll: { x: 50, y: 50 } });

    act(() => result.current.zoomToFit(null));

    expect(result.current.viewport).toEqual({ zoom: 1, scroll: { x: 0, y: 0 } });
  });

  it("goes back to the default view for a box with no area", () => {
    // A single point, a zero-height line: there is nothing to fit to.
    const { result } = setup({ zoom: 3, scroll: { x: 50, y: 50 } });

    act(() => result.current.zoomToFit({ x: 10, y: 10, width: 100, height: 0 }));

    expect(result.current.viewport).toEqual({ zoom: 1, scroll: { x: 0, y: 0 } });
  });
});

describe("scrollBy", () => {
  it("pans by a screen distance, whatever the zoom", () => {
    // The space bar drag and the scrollbars both pass screen pixels.
    const { result } = setup({ zoom: 4, scroll: { x: 0, y: 0 } });

    act(() => result.current.scrollBy(80, 40));

    expect(result.current.viewport.scroll).toEqual({ x: -20, y: -10 });
  });

  it("leaves the zoom alone", () => {
    const { result } = setup({ zoom: 2.5, scroll: { x: 0, y: 0 } });

    act(() => result.current.scrollBy(10, 10));

    expect(result.current.viewport.zoom).toBe(2.5);
  });
});
