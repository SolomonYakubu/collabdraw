import { describe, expect, it } from "vitest";
import {
  diamondPoints,
  distanceToEllipseOutline,
  distanceToSegment,
  exitBoxAlongRay,
  exitEllipseAlongRay,
  isPointInEllipse,
  isPointInPolygon,
  normalizeBox,
  simplifyPoints,
  snapAngle,
  unionBoxes,
} from "../geometry";

describe("distanceToSegment", () => {
  it("measures perpendicular distance inside the segment", () => {
    expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBe(3);
  });

  it("clamps to the endpoints beyond the segment", () => {
    expect(distanceToSegment(-4, 0, 0, 0, 10, 0)).toBe(4);
    expect(distanceToSegment(14, 0, 0, 0, 10, 0)).toBe(4);
  });

  it("handles a degenerate segment", () => {
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBe(5);
  });
});

describe("normalizeBox", () => {
  it("never produces negative extents", () => {
    expect(normalizeBox(10, 10, 4, 2)).toEqual({
      x: 4,
      y: 2,
      width: 6,
      height: 8,
    });
  });
});

describe("isPointInPolygon", () => {
  const diamond = diamondPoints({ x: 0, y: 0, width: 100, height: 100 });

  it("includes the centre", () => {
    expect(isPointInPolygon(50, 50, diamond)).toBe(true);
  });

  it("excludes the corners of the bounding box", () => {
    // The whole point of a diamond hit test: bounding-box corners are outside.
    expect(isPointInPolygon(2, 2, diamond)).toBe(false);
    expect(isPointInPolygon(98, 98, diamond)).toBe(false);
  });
});

describe("isPointInEllipse", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };

  it("includes the centre and excludes the box corners", () => {
    expect(isPointInEllipse(50, 25, box)).toBe(true);
    expect(isPointInEllipse(1, 1, box)).toBe(false);
  });
});

describe("distanceToEllipseOutline", () => {
  it("is ~0 on the outline", () => {
    const box = { x: 0, y: 0, width: 100, height: 100 };
    // Rightmost point of a circle of radius 50 centred at (50, 50).
    expect(distanceToEllipseOutline(100, 50, box)).toBeLessThan(0.5);
  });

  it("grows with distance from the outline", () => {
    const box = { x: 0, y: 0, width: 100, height: 100 };
    const near = distanceToEllipseOutline(105, 50, box);
    const far = distanceToEllipseOutline(130, 50, box);
    expect(near).toBeLessThan(far);
    expect(near).toBeCloseTo(5, 1);
  });
});

describe("exitBoxAlongRay", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };

  it("exits through the edge the ray is heading for", () => {
    expect(exitBoxAlongRay(box, { x: 90, y: 50 }, { x: 500, y: 50 })).toEqual({
      x: 100,
      y: 50,
    });
    expect(exitBoxAlongRay(box, { x: 50, y: 10 }, { x: 50, y: -500 })).toEqual({
      x: 50,
      y: 0,
    });
  });

  it("exits from an off-centre point without leaving the box", () => {
    // Regression: an earlier version shifted the box so the anchor became its
    // centre, which returned points outside the real shape.
    const exit = exitBoxAlongRay(box, { x: 90, y: 50 }, { x: 300, y: 50 });
    expect(exit.x).toBeLessThanOrEqual(100);
  });

  it("picks the nearest edge on a diagonal ray", () => {
    const exit = exitBoxAlongRay(box, { x: 90, y: 50 }, { x: 190, y: 100 });
    expect(exit.x).toBeCloseTo(100);
    expect(exit.y).toBeCloseTo(55);
  });

  it("returns the origin for a degenerate ray", () => {
    expect(exitBoxAlongRay(box, { x: 30, y: 30 }, { x: 30, y: 30 })).toEqual({
      x: 30,
      y: 30,
    });
  });
});

describe("exitEllipseAlongRay", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };

  it("exits on the ellipse", () => {
    const exit = exitEllipseAlongRay(box, { x: 50, y: 50 }, { x: 400, y: 50 });
    expect(exit.x).toBeCloseTo(100);
    expect(exit.y).toBeCloseTo(50);
  });

  it("exits on the ellipse from an off-centre anchor", () => {
    const exit = exitEllipseAlongRay(box, { x: 70, y: 50 }, { x: 400, y: 200 });
    // Must satisfy the ellipse equation.
    const nx = (exit.x - 50) / 50;
    const ny = (exit.y - 50) / 50;
    expect(nx * nx + ny * ny).toBeCloseTo(1, 3);
  });

  it("returns the origin for a degenerate ellipse", () => {
    expect(
      exitEllipseAlongRay(
        { x: 0, y: 0, width: 0, height: 10 },
        { x: 0, y: 5 },
        { x: 9, y: 5 },
      ),
    ).toEqual({ x: 0, y: 5 });
  });
});

describe("snapAngle", () => {
  it("snaps to the nearest 15 degree increment, keeping the length", () => {
    const from = { x: 0, y: 0 };
    const snapped = snapAngle(from, { x: 100, y: 4 });
    expect(snapped.y).toBeCloseTo(0);
    expect(Math.hypot(snapped.x, snapped.y)).toBeCloseTo(Math.hypot(100, 4));
  });

  it("leaves a zero-length drag alone", () => {
    expect(snapAngle({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});

describe("simplifyPoints", () => {
  it("collapses collinear points", () => {
    const straight = [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0];
    expect(simplifyPoints(straight, 0.5)).toEqual([0, 0, 5, 0]);
  });

  it("keeps a corner", () => {
    const corner = [0, 0, 5, 0, 10, 0, 10, 5, 10, 10];
    const simplified = simplifyPoints(corner, 0.5);
    expect(simplified).toContain(10);
    // Start, corner and end survive.
    expect(simplified.length).toBe(6);
  });

  it("passes very short strokes through untouched", () => {
    expect(simplifyPoints([0, 0, 1, 1], 1)).toEqual([0, 0, 1, 1]);
  });
});

describe("unionBoxes", () => {
  it("returns null for no boxes", () => {
    expect(unionBoxes([])).toBeNull();
  });

  it("covers every box", () => {
    expect(
      unionBoxes([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: -5, width: 5, height: 5 },
      ]),
    ).toEqual({ x: 0, y: -5, width: 25, height: 15 });
  });
});
