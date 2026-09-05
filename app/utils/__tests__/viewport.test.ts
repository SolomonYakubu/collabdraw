import { describe, expect, it } from "vitest";
import {
  applyViewportTransform,
  clientToWorld,
  getVisibleWorldBounds,
  INITIAL_VIEWPORT,
  screenDistanceToWorld,
  screenToWorld,
  scrollToFit,
  worldToScreen,
  zoomAtCenter,
  zoomAtPoint,
} from "../viewport";
import { MAX_ZOOM, MIN_ZOOM, type Viewport } from "../../types/shapes";

const viewport: Viewport = { zoom: 2.5, scroll: { x: -120, y: 37 } };

describe("screenToWorld / worldToScreen", () => {
  it("round-trips at any zoom and scroll", () => {
    const world = screenToWorld(431, 96, viewport);
    const screen = worldToScreen(world.x, world.y, viewport);
    expect(screen.x).toBeCloseTo(431);
    expect(screen.y).toBeCloseTo(96);
  });

  it("is the identity at zoom 1 with no scroll", () => {
    const identity: Viewport = { zoom: 1, scroll: { x: 0, y: 0 } };
    expect(screenToWorld(10, 20, identity)).toEqual({ x: 10, y: 20 });
  });
});

describe("clientToWorld", () => {
  it("subtracts the canvas offset", () => {
    const rect = { left: 40, top: 15 } as DOMRect;
    const identity: Viewport = { zoom: 1, scroll: { x: 0, y: 0 } };
    expect(clientToWorld(100, 100, rect, identity)).toEqual({ x: 60, y: 85 });
  });
});

describe("zoomAtPoint", () => {
  it("keeps the world point under the anchor fixed", () => {
    const anchor = { x: 300, y: 180 };
    const before = screenToWorld(anchor.x, anchor.y, viewport);

    const zoomed = zoomAtPoint(viewport, viewport.zoom * 1.7, anchor);
    const after = screenToWorld(anchor.x, anchor.y, zoomed);

    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps to the zoom limits", () => {
    expect(zoomAtPoint(viewport, 1e6, { x: 0, y: 0 }).zoom).toBeLessThanOrEqual(30);
    expect(zoomAtPoint(viewport, 1e-6, { x: 0, y: 0 }).zoom).toBeGreaterThanOrEqual(
      0.1,
    );
  });

  it("returns the same object when the zoom does not change", () => {
    expect(zoomAtPoint(viewport, viewport.zoom, { x: 5, y: 5 })).toBe(viewport);
  });
});

describe("zoomAtCenter", () => {
  /*
   * The zoom buttons and ctrl+`+`/`-` have no pointer to anchor to, so they
   * anchor on the middle of the canvas. If the anchor were the origin instead,
   * every keyboard zoom would drag the drawing towards the top-left corner.
   */
  it("keeps the world point in the middle of the canvas fixed", () => {
    const size = { width: 900, height: 640 };
    const centre = { x: size.width / 2, y: size.height / 2 };
    const before = screenToWorld(centre.x, centre.y, viewport);

    const zoomed = zoomAtCenter(viewport, viewport.zoom / 3, size);
    const after = screenToWorld(centre.x, centre.y, zoomed);

    expect(zoomed.zoom).toBeCloseTo(viewport.zoom / 3);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps like zoomAtPoint, which it delegates to", () => {
    const size = { width: 800, height: 600 };
    expect(zoomAtCenter(viewport, 1e6, size).zoom).toBe(MAX_ZOOM);
    expect(zoomAtCenter(viewport, 0, size).zoom).toBe(MIN_ZOOM);
    expect(zoomAtCenter(viewport, viewport.zoom, size)).toBe(viewport);
  });
});

describe("screenDistanceToWorld", () => {
  /*
   * Hit-test slop, handle sizes and snap radii are all authored in screen
   * pixels so they stay the same size under the cursor at any zoom. Getting
   * this the wrong way round makes selection unusably tight when zoomed in.
   */
  it("is the screen distance divided by the zoom", () => {
    expect(screenDistanceToWorld(10, viewport)).toBeCloseTo(4);
    expect(screenDistanceToWorld(10, { zoom: 0.5, scroll: { x: 0, y: 0 } })).toBe(
      20,
    );
  });

  it("matches the distance the transform actually puts between two points", () => {
    const a = screenToWorld(100, 0, viewport);
    const b = screenToWorld(112, 0, viewport);
    expect(screenDistanceToWorld(12, viewport)).toBeCloseTo(b.x - a.x);
  });
});

describe("applyViewportTransform", () => {
  it("matches the maths screenToWorld inverts", () => {
    const calls: number[][] = [];
    const context = {
      setTransform: (...args: number[]) => calls.push(args),
    } as unknown as CanvasRenderingContext2D;

    const dpr = 2;
    applyViewportTransform(context, viewport, dpr);
    const [a, , , , e, f] = calls[0];

    // A world point must land on the same device pixel the pointer maths uses.
    const world = { x: 17, y: -9 };
    const screen = worldToScreen(world.x, world.y, viewport);

    expect(a * world.x + e).toBeCloseTo(screen.x * dpr);
    expect(a * world.y + f).toBeCloseTo(screen.y * dpr);
  });
});

describe("getVisibleWorldBounds", () => {
  it("covers exactly the visible region", () => {
    const size = { width: 800, height: 600 };
    const bounds = getVisibleWorldBounds(viewport, size);
    const topLeft = screenToWorld(0, 0, viewport);
    const bottomRight = screenToWorld(size.width, size.height, viewport);

    expect(bounds.x).toBeCloseTo(topLeft.x);
    expect(bounds.y).toBeCloseTo(topLeft.y);
    expect(bounds.width).toBeCloseTo(bottomRight.x - topLeft.x);
    expect(bounds.height).toBeCloseTo(bottomRight.y - topLeft.y);
  });
});

describe("scrollToFit", () => {
  const size = { width: 1000, height: 800 };
  const margin = 64;

  /** Where the four corners of a world box land on screen under a viewport. */
  const framed = (
    box: { x: number; y: number; width: number; height: number },
    result: Viewport,
  ) => {
    const topLeft = worldToScreen(box.x, box.y, result);
    const bottomRight = worldToScreen(
      box.x + box.width,
      box.y + box.height,
      result,
    );
    return { topLeft, bottomRight };
  };

  it("centres the box in the viewport", () => {
    // Zoom to fit must put the drawing in the middle, not merely on screen:
    // an off-centre fit looks like the scene has been nudged sideways.
    const box = { x: -400, y: 900, width: 2000, height: 500 };
    const result = scrollToFit(box, size);
    const centre = worldToScreen(
      box.x + box.width / 2,
      box.y + box.height / 2,
      result,
    );

    expect(centre.x).toBeCloseTo(size.width / 2);
    expect(centre.y).toBeCloseTo(size.height / 2);
  });

  it("leaves the margin on the axis that limits the fit", () => {
    // 2000 wide against 1000 - 128 usable px is the tighter constraint, so the
    // width lands exactly on the margin and the height has room to spare.
    const box = { x: 0, y: 0, width: 2000, height: 500 };
    const result = scrollToFit(box, size);
    const { topLeft, bottomRight } = framed(box, result);

    expect(result.zoom).toBeCloseTo((size.width - margin * 2) / box.width);
    expect(topLeft.x).toBeCloseTo(margin);
    expect(bottomRight.x).toBeCloseTo(size.width - margin);
    expect(topLeft.y).toBeGreaterThan(margin);
    expect(bottomRight.y).toBeLessThan(size.height - margin);
  });

  it("fits a tall box on the other axis", () => {
    const box = { x: 12, y: -50, width: 200, height: 4000 };
    const result = scrollToFit(box, size);
    const { topLeft, bottomRight } = framed(box, result);

    expect(result.zoom).toBeCloseTo((size.height - margin * 2) / box.height);
    expect(topLeft.y).toBeCloseTo(margin);
    expect(bottomRight.y).toBeCloseTo(size.height - margin);
  });

  it("never magnifies past 1:1", () => {
    // Fitting a single small shape should centre it at its natural size, not
    // blow it up to fill the window.
    const box = { x: 100, y: 100, width: 40, height: 30 };
    const result = scrollToFit(box, size);

    expect(result.zoom).toBe(1);
    expect(worldToScreen(box.x + 20, box.y + 15, result)).toEqual({
      x: size.width / 2,
      y: size.height / 2,
    });
  });

  it("clamps a huge box to the minimum zoom", () => {
    const result = scrollToFit(
      { x: 0, y: 0, width: 5_000_000, height: 5_000_000 },
      size,
    );
    expect(result.zoom).toBe(MIN_ZOOM);
  });

  it("clamps rather than flipping when the canvas is thinner than the margins", () => {
    // A 100x80 canvas leaves (100 - 128) = -28 usable pixels. Without the
    // clamp the fit zoom would be negative and mirror the whole scene.
    const result = scrollToFit({ x: 0, y: 0, width: 300, height: 200 }, {
      width: 100,
      height: 80,
    });
    expect(result.zoom).toBe(MIN_ZOOM);
  });

  it("honours a caller's margin", () => {
    const box = { x: 0, y: 0, width: 2000, height: 500 };
    expect(scrollToFit(box, size, 0).zoom).toBeCloseTo(size.width / box.width);
    expect(scrollToFit(box, size, 200).zoom).toBeCloseTo(
      (size.width - 400) / box.width,
    );
  });

  it("returns the initial viewport for a degenerate box or canvas", () => {
    /*
     * An empty scene's bounding box is zero-sized, and the canvas measures
     * 0x0 for the first frame after mount. Either would divide by zero and put
     * NaN in the viewport, which blanks the canvas until a reload.
     */
    for (const box of [
      { x: 0, y: 0, width: 0, height: 100 },
      { x: 0, y: 0, width: 100, height: 0 },
      { x: 0, y: 0, width: -100, height: -100 },
    ]) {
      expect(scrollToFit(box, size)).toBe(INITIAL_VIEWPORT);
    }

    const box = { x: 0, y: 0, width: 100, height: 100 };
    expect(scrollToFit(box, { width: 0, height: 600 })).toBe(INITIAL_VIEWPORT);
    expect(scrollToFit(box, { width: 800, height: 0 })).toBe(INITIAL_VIEWPORT);
  });
});
