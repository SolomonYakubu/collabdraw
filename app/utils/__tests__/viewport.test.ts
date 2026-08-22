import { describe, expect, it } from "vitest";
import {
  applyViewportTransform,
  clientToWorld,
  getVisibleWorldBounds,
  screenToWorld,
  worldToScreen,
  zoomAtPoint,
} from "../viewport";
import type { Viewport } from "../../types/shapes";

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
