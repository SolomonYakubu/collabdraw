import { describe, expect, it } from "vitest";
import { snapToPoint } from "../pointSnapping";
import { createElement } from "../elements";
import { refreshLinearElement } from "../linearElement";
import type { LinearShape, Shape } from "../../../types/shapes";

const square = (x: number, y: number, size = 100): Shape =>
  createElement("Square", { x, y, width: size, height: size })!;

const box = square(100, 100, 200); // corners at 100,100 / 300,100 / 300,300 / 100,300

describe("snapToPoint", () => {
  it("grabs a corner from nearby", () => {
    const result = snapToPoint({ x: 296, y: 104 }, [box], 12);

    expect(result.point).toEqual({ x: 300, y: 100 });
    expect(result.snappedTo?.kind).toBe("corner");
  });

  it("leaves the pointer alone when nothing is close", () => {
    const pointer = { x: 700, y: 700 };
    const result = snapToPoint(pointer, [box], 12);

    expect(result.point).toBe(pointer);
    expect(result.snappedTo).toBeNull();
  });

  it("finds edge midpoints and the centre", () => {
    expect(snapToPoint({ x: 202, y: 98 }, [box], 12).snappedTo?.kind).toBe(
      "midpoint",
    );
    expect(snapToPoint({ x: 201, y: 199 }, [box], 12).snappedTo?.kind).toBe(
      "center",
    );
  });

  it("prefers a corner when a corner and something else are equally close", () => {
    // Two squares meeting: the corner of one coincides with the midpoint of the
    // other's edge. A corner is what someone aiming there wants.
    const neighbour = square(300, 50, 100); // its left edge midpoint is (300,100)
    const result = snapToPoint({ x: 300, y: 100 }, [box, neighbour], 12);

    expect(result.point).toEqual({ x: 300, y: 100 });
    expect(result.snappedTo?.kind).toBe("corner");
  });

  it("uses a diamond's points, not its bounding box's corners", () => {
    const diamond = createElement("Diamond", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })!;

    // The top point of the diamond.
    expect(snapToPoint({ x: 52, y: 3 }, [diamond], 12).point).toEqual({
      x: 50,
      y: 0,
    });

    // The bounding box's own corner is not a snap target.
    expect(snapToPoint({ x: 1, y: 1 }, [diamond], 12).snappedTo).toBeNull();
  });

  it("uses a triangle's three points, not its bounding box's corners", () => {
    const triangle = createElement("Triangle", {
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    })!;

    // Apex, then the two base corners.
    expect(snapToPoint({ x: 102, y: 3 }, [triangle], 12).point).toEqual({
      x: 100,
      y: 0,
    });
    expect(snapToPoint({ x: 3, y: 97 }, [triangle], 12).point).toEqual({
      x: 0,
      y: 100,
    });

    // The box's top-left is not on the shape, so it is not a target.
    expect(snapToPoint({ x: 2, y: 2 }, [triangle], 12).snappedTo).toBeNull();
  });

  it("ignores an ellipse's bounding corners but keeps its quadrant points", () => {
    const ellipse = createElement("Circle", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })!;

    expect(snapToPoint({ x: 2, y: 2 }, [ellipse], 12).snappedTo).toBeNull();
    expect(snapToPoint({ x: 98, y: 50 }, [ellipse], 12).point).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("snaps to the ends of another line, so two lines meet exactly", () => {
    const line = refreshLinearElement(
      createElement("Line", { x1: 10, y1: 10, x2: 90, y2: 90 }) as LinearShape,
      [],
    );

    const result = snapToPoint({ x: 87, y: 93 }, [line], 12);
    expect(result.point).toEqual({ x: 90, y: 90 });
    expect(result.snappedTo?.kind).toBe("endpoint");
  });

  it("excludes the element being drawn, so a line cannot snap to itself", () => {
    const line = refreshLinearElement(
      createElement("Line", {
        id: "self",
        x1: 10,
        y1: 10,
        x2: 90,
        y2: 90,
      }) as LinearShape,
      [],
    );

    expect(
      snapToPoint({ x: 12, y: 12 }, [line], 12, new Set(["self"])).snappedTo,
    ).toBeNull();
  });

  it("takes the nearest of several candidates", () => {
    const result = snapToPoint({ x: 292, y: 108 }, [box], 20);
    expect(result.point).toEqual({ x: 300, y: 100 });
  });

  it("does nothing at a zero threshold", () => {
    const pointer = { x: 300, y: 100 };
    expect(snapToPoint(pointer, [box], 0).point).toBe(pointer);
  });

  it("skips deleted elements", () => {
    const deleted = { ...box, isDeleted: true };
    expect(snapToPoint({ x: 300, y: 100 }, [deleted], 12).snappedTo).toBeNull();
  });

  it("lets corner-to-corner joins land exactly, which is the point", () => {
    // Two faces of a cube: the near square and the far square, offset.
    const near = square(100, 100, 200);
    const far = square(180, 40, 200);

    // Joining the top-left of one to the top-left of the other.
    const from = snapToPoint({ x: 103, y: 97 }, [near, far], 12);
    const to = snapToPoint({ x: 183, y: 44 }, [near, far], 12);

    expect(from.point).toEqual({ x: 100, y: 100 });
    expect(to.point).toEqual({ x: 180, y: 40 });
  });
});
