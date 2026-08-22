import { describe, expect, it } from "vitest";
import {
  createElement,
  fromElementLocal,
  getElementBounds,
  getElementCenter,
  getRotatedBounds,
  toElementLocal,
} from "../elements";
import {
  applyRotatedResize,
  getResizedBounds,
  getSelectionBounds,
  setElementAngle,
} from "../transform";
import { applyBindings, createBinding } from "../bindings";
import { hitTestElement } from "../hitTest";
import { snapToPoint } from "../pointSnapping";
import {
  normalizeAngle,
  rotatePoint,
  rotateVector,
  rotatedBoxAABB,
  snapAngleValue,
} from "../../../utils/geometry";
import type { LinearShape, Shape } from "../../../types/shapes";

const QUARTER = Math.PI / 2;

const boxAt = (
  x: number,
  y: number,
  width = 200,
  height = 100,
  angle = 0,
): Shape => createElement("Square", { x, y, width, height, angle })!;

describe("rotation primitives", () => {
  it("rotates a point about a centre", () => {
    const rotated = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, QUARTER);
    expect(rotated.x).toBeCloseTo(0);
    expect(rotated.y).toBeCloseTo(10);
  });

  it("leaves a point alone at zero, returning a copy", () => {
    const point = { x: 3, y: 4 };
    const result = rotatePoint(point, { x: 0, y: 0 }, 0);
    expect(result).toEqual(point);
    expect(result).not.toBe(point);
  });

  it("rotates a free vector without a centre", () => {
    const rotated = rotateVector({ x: 0, y: 5 }, QUARTER);
    expect(rotated.x).toBeCloseTo(-5);
    expect(rotated.y).toBeCloseTo(0);
  });

  it("wraps angles into one turn", () => {
    expect(normalizeAngle(-QUARTER)).toBeCloseTo(Math.PI * 1.5);
    expect(normalizeAngle(Math.PI * 4.5)).toBeCloseTo(Math.PI * 0.5);
  });

  it("snaps an angle to 15 degree steps", () => {
    const step = (15 * Math.PI) / 180;
    expect(snapAngleValue(step * 2 + 0.02)).toBeCloseTo(step * 2);
  });

  it("grows the axis-aligned box of a rotated rectangle", () => {
    const upright = { x: 0, y: 0, width: 200, height: 100 };

    // A quarter turn swaps the extents.
    const turned = rotatedBoxAABB(upright, QUARTER);
    expect(turned.width).toBeCloseTo(100);
    expect(turned.height).toBeCloseTo(200);

    // A diagonal turn is larger than either.
    const diagonal = rotatedBoxAABB(upright, Math.PI / 4);
    expect(diagonal.width).toBeGreaterThan(200);
  });

  it("leaves an unrotated box untouched", () => {
    const upright = { x: 5, y: 6, width: 20, height: 30 };
    expect(rotatedBoxAABB(upright, 0)).toEqual(upright);
  });
});

describe("local and world frames", () => {
  const element = boxAt(0, 0, 200, 100, QUARTER);

  it("round-trips a point", () => {
    const world = { x: 137, y: -42 };
    const back = fromElementLocal(toElementLocal(world, element), element);

    expect(back.x).toBeCloseTo(world.x);
    expect(back.y).toBeCloseTo(world.y);
  });

  it("leaves the centre fixed", () => {
    const centre = getElementCenter(element);
    const mapped = toElementLocal(centre, element);

    expect(mapped.x).toBeCloseTo(centre.x);
    expect(mapped.y).toBeCloseTo(centre.y);
  });

  it("is the identity for an upright element", () => {
    const upright = boxAt(0, 0);
    const point = { x: 12, y: 34 };
    expect(toElementLocal(point, upright)).toBe(point);
  });

  it("does not move the element's own stored geometry", () => {
    // Rotation is presentation; the stored box is still the unrotated one.
    expect(getElementBounds(element)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
  });
});

describe("selection bounds", () => {
  it("reports a single element's own box, so the frame can turn with it", () => {
    const turned = boxAt(0, 0, 200, 100, Math.PI / 4);
    expect(getSelectionBounds([turned])).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
  });

  it("combines on-screen extents for several elements", () => {
    // Two elements, one turned: the upright hull has to cover the turned extent.
    const turned = boxAt(0, 0, 200, 100, QUARTER);
    const other = boxAt(300, 300, 50, 50);
    const bounds = getSelectionBounds([turned, other])!;

    const turnedExtent = getRotatedBounds(turned);
    expect(bounds.x).toBeLessThanOrEqual(turnedExtent.x + 0.01);
    expect(bounds.y).toBeLessThanOrEqual(turnedExtent.y + 0.01);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(350 - 0.01);
  });
});

describe("resizing a rotated element", () => {
  /**
   * The property that matters: the corner opposite the handle must not move.
   * Rotation happens about the element's centre, so changing the box moves that
   * centre and would otherwise drag the whole shape sideways.
   */
  const anchorStaysPut = (angle: number, handle: "se" | "nw" | "e" | "s") => {
    const initial = { x: 100, y: 100, width: 200, height: 100 };
    const element = boxAt(initial.x, initial.y, initial.width, initial.height, angle);

    /*
     * The point that must not move: the corner opposite a corner handle, or the
     * opposite edge's midpoint for a side handle. Read from whichever box is in
     * question, because the correction shifts the stored coordinates as well as
     * the centre.
     */
    const anchorOf = (box: typeof initial) => {
      switch (handle) {
        case "se":
          return { x: box.x, y: box.y };
        case "nw":
          return { x: box.x + box.width, y: box.y + box.height };
        case "e":
          return { x: box.x, y: box.y + box.height / 2 };
        default:
          return { x: box.x + box.width / 2, y: box.y };
      }
    };

    const before = fromElementLocal(anchorOf(initial), element);

    const next = getResizedBounds(handle, initial, { x: 400, y: 260 });
    const resized = applyRotatedResize(element, initial, next);
    const after = fromElementLocal(anchorOf(getElementBounds(resized)), resized);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  };

  it("keeps the opposite corner fixed at a quarter turn", () => {
    anchorStaysPut(QUARTER, "se");
    anchorStaysPut(QUARTER, "nw");
  });

  it("keeps it fixed at an awkward angle", () => {
    anchorStaysPut(0.7, "se");
    anchorStaysPut(-1.3, "nw");
  });

  it("keeps it fixed for side handles too", () => {
    anchorStaysPut(0.5, "e");
    anchorStaysPut(0.5, "s");
  });

  it("changes nothing for an upright element", () => {
    const initial = { x: 0, y: 0, width: 100, height: 100 };
    const element = boxAt(0, 0, 100, 100);
    const next = getResizedBounds("se", initial, { x: 200, y: 200 });

    expect(getElementBounds(applyRotatedResize(element, initial, next))).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
  });
});

describe("rotation and the rest of the editor", () => {
  it("snaps to a rotated shape's corners where they actually are", () => {
    const turned = boxAt(0, 0, 200, 100, QUARTER);

    // Rotated a quarter turn about (100, 50), the top-left corner lands here.
    const expected = fromElementLocal({ x: 0, y: 0 }, turned);
    const result = snapToPoint(
      { x: expected.x + 3, y: expected.y - 2 },
      [turned],
      12,
    );

    expect(result.point.x).toBeCloseTo(expected.x);
    expect(result.point.y).toBeCloseTo(expected.y);
    expect(result.snappedTo?.kind).toBe("corner");
  });

  it("keeps a bound arrow outside a rotated shape", () => {
    const shape = createElement("Square", {
      id: "box",
      x: 0,
      y: 0,
      width: 160,
      height: 160,
      angle: Math.PI / 4,
    })!;

    const arrow = createElement("Arrow", {
      id: "arrow",
      x1: 400,
      y1: 80,
      x2: 80,
      y2: 80,
    })!;

    const scene = applyBindings([shape, arrow], "arrow", {
      end: createBinding(shape, { x: 80, y: 80 }, 24),
    });

    const bound = scene.find((element) => element.id === "arrow") as LinearShape;
    const turned = scene.find((element) => element.id === "box")!;

    // The endpoint stops short of the turned outline rather than entering it.
    expect(hitTestElement({ x: bound.x2, y: bound.y2 }, turned, 0)).toBe(false);
  });

  it("moves an arrow when the shape it is bound to is rotated", () => {
    const shape = createElement("Square", {
      id: "box",
      x: 0,
      y: 0,
      width: 200,
      height: 60,
    })!;
    const arrow = createElement("Arrow", {
      id: "arrow",
      x1: 500,
      y1: 30,
      x2: 200,
      y2: 30,
    })!;

    const before = applyBindings([shape, arrow], "arrow", {
      end: createBinding(shape, { x: 200, y: 30 }, 24),
    });
    const beforeEnd = (before.find((e) => e.id === "arrow") as LinearShape).x2;

    // Turn the bar upright; the arrow should now stop much further left.
    const turned = before.map((element) =>
      element.id === "box" ? setElementAngle(element, QUARTER) : element,
    );
    const after = applyBindings(turned, "arrow", {});
    const afterEnd = (after.find((e) => e.id === "arrow") as LinearShape).x2;

    expect(afterEnd).not.toBeCloseTo(beforeEnd);
  });

  it("marquee-selects a rotated shape by its on-screen extent", () => {
    const turned = boxAt(0, 0, 200, 40, QUARTER);
    const extent = getRotatedBounds(turned);

    // Turned upright, the bar reaches well below its unrotated box.
    expect(extent.height).toBeCloseTo(200);
    expect(extent.width).toBeCloseTo(40);
  });
});
