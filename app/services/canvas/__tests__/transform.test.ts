import { describe, expect, it } from "vitest";
import { createElement, getElementBounds } from "../elements";
import {
  applyResizeToElements,
  getResizedBounds,
  getSelectionBounds,
} from "../transform";
import { getSnapOffset } from "../snapping";
import type { Shape } from "../../../types/shapes";

const initial = { x: 100, y: 100, width: 200, height: 100 };

const boxAt = (x: number, y: number, width = 50, height = 50): Shape =>
  createElement("Square", { x, y, width, height })!;

describe("getResizedBounds", () => {
  it("moves the dragged edge only", () => {
    expect(getResizedBounds("e", initial, { x: 400, y: 0 })).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 100,
    });

    expect(getResizedBounds("w", initial, { x: 50, y: 0 })).toEqual({
      x: 50,
      y: 100,
      width: 250,
      height: 100,
    });
  });

  it("moves two edges for a corner handle", () => {
    expect(getResizedBounds("nw", initial, { x: 50, y: 50 })).toEqual({
      x: 50,
      y: 50,
      width: 250,
      height: 150,
    });
  });

  it("never inverts when dragged past the opposite edge", () => {
    const result = getResizedBounds("w", initial, { x: 9999, y: 0 });
    expect(result.width).toBeGreaterThan(0);
    expect(result.x).toBeLessThanOrEqual(initial.x + initial.width);
  });

  it("preserves the aspect ratio on a corner handle when asked", () => {
    const result = getResizedBounds(
      "se",
      initial,
      { x: 500, y: 120 },
      { preserveAspectRatio: true },
    );
    expect(result.width / result.height).toBeCloseTo(
      initial.width / initial.height,
    );
  });

  it("resizes about the centre with fromCenter", () => {
    const result = getResizedBounds(
      "e",
      initial,
      { x: 300, y: 0 },
      { fromCenter: true },
    );
    const centerBefore = initial.x + initial.width / 2;
    expect(result.x + result.width / 2).toBeCloseTo(centerBefore);
  });
});

describe("applyResizeToElements", () => {
  it("keeps relative positions within the selection", () => {
    const a = boxAt(100, 100);
    const b = boxAt(250, 150);
    const bounds = getSelectionBounds([a, b])!;

    const doubled = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width * 2,
      height: bounds.height * 2,
    };

    const [ra, rb] = applyResizeToElements([a, b], bounds, doubled);

    expect(getElementBounds(ra).x).toBeCloseTo(bounds.x);
    expect(getElementBounds(rb).x).toBeCloseTo(
      bounds.x + (250 - bounds.x) * 2,
    );
    expect(getElementBounds(ra).width).toBeCloseTo(100);
  });

  it("is a no-op for a degenerate starting box", () => {
    const a = boxAt(0, 0);
    const result = applyResizeToElements(
      [a],
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 10, height: 10 },
    );
    expect(result[0]).toBe(a);
  });
});

describe("getSelectionBounds", () => {
  it("returns null for an empty selection", () => {
    expect(getSelectionBounds([])).toBeNull();
  });

  it("covers every element", () => {
    expect(getSelectionBounds([boxAt(0, 0), boxAt(100, 100)])).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 150,
    });
  });
});

describe("getSnapOffset", () => {
  const stationary = boxAt(200, 200, 100, 100);

  it("snaps a near-aligned edge and reports a guide", () => {
    const moving = { x: 197, y: 400, width: 100, height: 100 };
    const result = getSnapOffset(moving, [stationary], new Set(), 6);

    expect(result.offset.x).toBeCloseTo(3);
    expect(result.guides.some((guide) => guide.orientation === "vertical")).toBe(
      true,
    );
  });

  it("leaves a distant shape alone", () => {
    const moving = { x: 900, y: 900, width: 100, height: 100 };
    const result = getSnapOffset(moving, [stationary], new Set(), 6);
    expect(result.offset).toEqual({ x: 0, y: 0 });
    expect(result.guides).toEqual([]);
  });

  it("ignores the elements being moved", () => {
    const result = getSnapOffset(
      getElementBounds(stationary),
      [stationary],
      new Set([stationary.id]),
      6,
    );
    expect(result.offset).toEqual({ x: 0, y: 0 });
  });

  it("does nothing when snapping is disabled", () => {
    const moving = { x: 197, y: 200, width: 100, height: 100 };
    expect(getSnapOffset(moving, [stationary], new Set(), 0).offset).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("snaps centres, not only edges", () => {
    // Moving box centre at 249 vs stationary centre at 250.
    const moving = { x: 199, y: 400, width: 100, height: 100 };
    const result = getSnapOffset(moving, [stationary], new Set(), 6);
    expect(result.offset.x).toBeCloseTo(1);
  });
});
