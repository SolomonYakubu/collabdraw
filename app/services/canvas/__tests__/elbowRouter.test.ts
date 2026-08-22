import { describe, expect, it } from "vitest";
import {
  getFacingHeadings,
  getHeadingForPointOnBox,
  getSideAnchor,
  routeElbow,
  simplifyOrthogonalPath,
} from "../elbowRouter";
import type { BoundingBox, Point } from "../../../types/shapes";

const box = (x: number, y: number, width = 100, height = 100): BoundingBox => ({
  x,
  y,
  width,
  height,
});

/** Every segment of a route must be axis-aligned. */
const isOrthogonal = (path: readonly Point[]): boolean => {
  for (let i = 0; i + 1 < path.length; i += 1) {
    const dx = Math.abs(path[i + 1].x - path[i].x);
    const dy = Math.abs(path[i + 1].y - path[i].y);
    if (dx > 0.01 && dy > 0.01) {
      return false;
    }
  }
  return true;
};

/** Whether any segment cuts through a box's interior. */
const crossesBox = (path: readonly Point[], target: BoundingBox): boolean => {
  const inset = 0.5;
  const left = target.x + inset;
  const right = target.x + target.width - inset;
  const top = target.y + inset;
  const bottom = target.y + target.height - inset;

  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);

    if (maxX > left && minX < right && maxY > top && minY < bottom) {
      return true;
    }
  }

  return false;
};

const countTurns = (path: readonly Point[]): number => {
  let turns = 0;
  for (let i = 1; i + 1 < path.length; i += 1) {
    const beforeHorizontal = Math.abs(path[i].y - path[i - 1].y) < 0.01;
    const afterHorizontal = Math.abs(path[i + 1].y - path[i].y) < 0.01;
    if (beforeHorizontal !== afterHorizontal) {
      turns += 1;
    }
  }
  return turns;
};

describe("simplifyOrthogonalPath", () => {
  it("drops duplicate and collinear points", () => {
    const simplified = simplifyOrthogonalPath([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ]);

    expect(simplified).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ]);
  });

  it("keeps a genuine staircase intact", () => {
    const staircase = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
    ];
    expect(simplifyOrthogonalPath(staircase)).toEqual(staircase);
  });
});

describe("routeElbow", () => {
  it("produces a straight run when the ends already line up", () => {
    const path = routeElbow({ start: { x: 0, y: 50 }, end: { x: 200, y: 50 } });
    expect(path).toEqual([
      { x: 0, y: 50 },
      { x: 200, y: 50 },
    ]);
  });

  it("stays orthogonal with no obstacles", () => {
    const path = routeElbow({ start: { x: 0, y: 0 }, end: { x: 120, y: 90 } });
    expect(isOrthogonal(path)).toBe(true);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 120, y: 90 });
  });

  it("leaves along the heading it is given", () => {
    const path = routeElbow({
      start: { x: 0, y: 0 },
      end: { x: 120, y: 90 },
      startHeading: "up",
    });

    // First move must be upwards, not straight at the target.
    expect(path[1].y).toBeLessThan(path[0].y);
    expect(isOrthogonal(path)).toBe(true);
  });

  it("routes around a shape sitting between the two ends", () => {
    const obstacle = box(80, 0, 100, 100);
    const path = routeElbow({
      start: { x: 0, y: 50 },
      end: { x: 300, y: 50 },
      obstacles: [obstacle],
    });

    expect(isOrthogonal(path)).toBe(true);
    expect(crossesBox(path, obstacle)).toBe(false);
    // Going around needs at least a step out and a step back.
    expect(path.length).toBeGreaterThan(2);
  });

  it("connects two bound shapes without cutting through either", () => {
    const from = box(0, 0);
    const to = box(300, 200);
    const headings = getFacingHeadings(from, to);

    const path = routeElbow({
      start: getSideAnchor(from, headings.start, 4),
      end: getSideAnchor(to, headings.end, 4),
      startHeading: headings.start,
      endHeading: headings.end,
      obstacles: [from, to],
    });

    expect(isOrthogonal(path)).toBe(true);
    expect(crossesBox(path, from)).toBe(false);
    expect(crossesBox(path, to)).toBe(false);
  });

  it("threads a tight gap between two shapes", () => {
    // Two obstacles with a narrow corridor between them.
    const upper = box(100, 0, 100, 90);
    const lower = box(100, 150, 100, 90);

    const path = routeElbow({
      start: { x: 0, y: 120 },
      end: { x: 300, y: 120 },
      obstacles: [upper, lower],
    });

    expect(isOrthogonal(path)).toBe(true);
    expect(crossesBox(path, upper)).toBe(false);
    expect(crossesBox(path, lower)).toBe(false);
  });

  it("prefers few turns", () => {
    const path = routeElbow({
      start: { x: 0, y: 0 },
      end: { x: 300, y: 200 },
      obstacles: [box(500, 500)],
    });

    // Nothing is in the way, so one bend is enough.
    expect(countTurns(path)).toBeLessThanOrEqual(2);
  });

  it("still returns a usable path when an end is walled in", () => {
    // The start sits inside the obstacle, so no route exists; the fallback must
    // still produce something orthogonal rather than throwing or returning [].
    const path = routeElbow({
      start: { x: 50, y: 50 },
      end: { x: 400, y: 400 },
      obstacles: [box(0, 0, 100, 100)],
    });

    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(isOrthogonal(path)).toBe(true);
    expect(path[path.length - 1]).toEqual({ x: 400, y: 400 });
  });

  it("always starts and ends exactly on the requested points", () => {
    const cases: Array<[Point, Point]> = [
      [{ x: 0, y: 0 }, { x: 10, y: 400 }],
      [{ x: 250, y: 30 }, { x: -90, y: -60 }],
      [{ x: 5, y: 5 }, { x: 5, y: 5 }],
    ];

    for (const [start, end] of cases) {
      const path = routeElbow({ start, end, obstacles: [box(60, 60)] });
      expect(path[0]).toEqual(start);
      expect(path[path.length - 1]).toEqual(end);
    }
  });
});

describe("getFacingHeadings", () => {
  it("goes sideways for shapes placed side by side", () => {
    expect(getFacingHeadings(box(0, 0), box(300, 0))).toEqual({
      start: "right",
      end: "left",
    });
    expect(getFacingHeadings(box(300, 0), box(0, 0))).toEqual({
      start: "left",
      end: "right",
    });
  });

  it("goes vertically for shapes stacked up", () => {
    expect(getFacingHeadings(box(0, 0), box(0, 300))).toEqual({
      start: "down",
      end: "up",
    });
    expect(getFacingHeadings(box(0, 300), box(0, 0))).toEqual({
      start: "up",
      end: "down",
    });
  });

  it("uses the axis on which the shapes are actually separated", () => {
    // Overlapping horizontally, clearly separated vertically.
    const headings = getFacingHeadings(box(0, 0), box(40, 400));
    expect(headings).toEqual({ start: "down", end: "up" });
  });
});

describe("getHeadingForPointOnBox / getSideAnchor", () => {
  const target = box(0, 0, 200, 100);

  it("names the closest side", () => {
    expect(getHeadingForPointOnBox({ x: 100, y: 2 }, target)).toBe("up");
    expect(getHeadingForPointOnBox({ x: 100, y: 98 }, target)).toBe("down");
    expect(getHeadingForPointOnBox({ x: 2, y: 50 }, target)).toBe("left");
    expect(getHeadingForPointOnBox({ x: 198, y: 50 }, target)).toBe("right");
  });

  it("anchors to the middle of that side, offset by the gap", () => {
    expect(getSideAnchor(target, "right", 4)).toEqual({ x: 204, y: 50 });
    expect(getSideAnchor(target, "up", 4)).toEqual({ x: 100, y: -4 });
  });
});
