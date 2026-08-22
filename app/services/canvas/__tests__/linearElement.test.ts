import { describe, expect, it } from "vitest";
import { createElement, getElementBounds, translateElement } from "../elements";
import { applyBindings, createBinding } from "../bindings";
import { hitTestElement } from "../hitTest";
import {
  getControlPoints,
  getEndDirection,
  getLinearPath,
  getSegmentMidpoints,
  insertWaypoint,
  moveWaypoint,
  refreshLinearElement,
  removeWaypoint,
  roundedPathD,
} from "../linearElement";
import type { LinearShape, Point, Shape } from "../../../types/shapes";

const arrow = (attrs: Record<string, unknown> = {}): LinearShape =>
  createElement("Arrow", {
    id: "arrow",
    x1: 0,
    y1: 0,
    x2: 200,
    y2: 0,
    ...attrs,
  }) as LinearShape;

const scene = (edgeStyle: "straight" | "curved" | "elbow") => {
  const from = createElement("Square", {
    id: "a",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  })!;
  const to = createElement("Square", {
    id: "b",
    x: 400,
    y: 300,
    width: 100,
    height: 100,
  })!;
  const connector = createElement("Arrow", {
    id: "arrow",
    x1: 100,
    y1: 50,
    x2: 400,
    y2: 350,
    edgeStyle,
  })!;

  return applyBindings([from, to, connector], "arrow", {
    start: createBinding(from, { x: 100, y: 50 }, 24),
    end: createBinding(to, { x: 400, y: 350 }, 24),
  });
};

const arrowOf = (elements: readonly Shape[]): LinearShape =>
  elements.find((element) => element.id === "arrow") as LinearShape;

const isOrthogonal = (path: readonly Point[]): boolean =>
  path.every((point, index) => {
    if (index === 0) {
      return true;
    }
    const dx = Math.abs(point.x - path[index - 1].x);
    const dy = Math.abs(point.y - path[index - 1].y);
    return dx < 0.01 || dy < 0.01;
  });

describe("waypoints", () => {
  it("starts with none", () => {
    expect(arrow().midPoints).toEqual([]);
    expect(getControlPoints(arrow())).toHaveLength(2);
  });

  it("inserts a bend into a segment", () => {
    const bent = insertWaypoint(arrow(), 0, { x: 100, y: 80 });
    expect(bent.midPoints).toEqual([100, 80]);
    expect(getControlPoints(bent)).toHaveLength(3);
  });

  it("moves and removes a bend", () => {
    const bent = insertWaypoint(arrow(), 0, { x: 100, y: 80 });
    expect(moveWaypoint(bent, 0, { x: 120, y: 20 }).midPoints).toEqual([120, 20]);
    expect(removeWaypoint(bent, 0).midPoints).toEqual([]);
  });

  it("ignores out-of-range indices instead of corrupting the list", () => {
    const bent = insertWaypoint(arrow(), 0, { x: 100, y: 80 });
    expect(moveWaypoint(bent, 5, { x: 0, y: 0 })).toBe(bent);
    expect(removeWaypoint(bent, -1)).toBe(bent);
  });

  it("offers a midpoint per segment", () => {
    const bent = insertWaypoint(arrow(), 0, { x: 100, y: 80 });
    const midpoints = getSegmentMidpoints(bent);
    expect(midpoints).toHaveLength(2);
    expect(midpoints[0]).toEqual({ x: 50, y: 40 });
  });

  it("puts the bend on the drawn path and in the bounds", () => {
    const bent = refreshLinearElement(
      insertWaypoint(arrow(), 0, { x: 100, y: 120 }),
      [],
    );

    expect(getLinearPath(bent)).toHaveLength(3);
    // The bend pushes the box down even though both ends are at y = 0.
    expect(getElementBounds(bent).height).toBeCloseTo(120);
  });

  it("makes the bend grabbable", () => {
    const bent = refreshLinearElement(
      insertWaypoint(arrow(), 0, { x: 100, y: 120 }),
      [],
    );

    // A point near the bend is on the line, even though it is far from the ends.
    expect(hitTestElement({ x: 100, y: 118 }, bent, 6)).toBe(true);
    expect(hitTestElement({ x: 100, y: 4 }, bent, 6)).toBe(false);
  });

  it("moves bends and the route along with the element", () => {
    const bent = refreshLinearElement(
      insertWaypoint(arrow(), 0, { x: 100, y: 120 }),
      [],
    );
    const moved = translateElement(bent, 50, 10) as LinearShape;

    expect(moved.midPoints).toEqual([150, 130]);
    expect(moved.route[0]).toBeCloseTo(50);
    expect(getLinearPath(moved)[1]).toEqual({ x: 150, y: 130 });
  });
});

describe("keeping the drawn path in step with the ends", () => {
  /*
   * `route` is derived, and the renderer, the bounds and the hit test all read it
   * rather than the raw ends. Moving an end without re-resolving therefore leaves
   * an element that draws as nothing — which is exactly what happened when the
   * refresh was skipped for plain lines: every line came out invisible.
   */
  const asDrawn = (from: Point, to: Point): LinearShape => {
    // At pointer-down both ends sit on the origin, as the editor creates them.
    const created = createElement("Line", {
      x1: from.x,
      y1: from.y,
      x2: from.x,
      y2: from.y,
    }) as LinearShape;

    // Then the pointer moves.
    return refreshLinearElement(
      { ...created, x2: to.x, y2: to.y, version: created.version + 1 },
      [],
    );
  };

  it("gives a dragged-out line a path between its two ends", () => {
    const line = asDrawn({ x: 0, y: 0 }, { x: 300, y: 200 });

    expect(getLinearPath(line)).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 200 },
    ]);
  });

  it("gives it real bounds, so it is not culled or unselectable", () => {
    const line = asDrawn({ x: 0, y: 0 }, { x: 300, y: 200 });

    expect(getElementBounds(line)).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
  });

  it("makes it hittable along its length", () => {
    const line = asDrawn({ x: 0, y: 0 }, { x: 300, y: 200 });
    expect(hitTestElement({ x: 150, y: 100 }, line, 6)).toBe(true);
  });

  it("leaves a line that never moved degenerate, so it is discarded", () => {
    const line = asDrawn({ x: 50, y: 50 }, { x: 50, y: 50 });
    const bounds = getElementBounds(line);

    expect(bounds.width).toBe(0);
    expect(bounds.height).toBe(0);
  });
});

describe("lines versus arrows", () => {
  /*
   * A plain line must stay exactly where it is put. Binding used to apply to
   * lines as well as arrows, which dragged each end onto the nearest outline and
   * stood it off by the binding gap — so joining two corners to draw a cube was
   * impossible, the ends never met.
   */
  const corner = { x: 100, y: 100 };
  const shape = createElement("Square", {
    id: "box",
    x: 100,
    y: 100,
    width: 200,
    height: 200,
  })!;

  it("leaves an unbound line's ends untouched, even on a shape's corner", () => {
    const line = refreshLinearElement(
      createElement("Line", {
        x1: corner.x,
        y1: corner.y,
        x2: 300,
        y2: 40,
      }) as LinearShape,
      [shape],
    );

    expect(line.x1).toBe(corner.x);
    expect(line.y1).toBe(corner.y);
    expect(line.x2).toBe(300);
    expect(line.y2).toBe(40);
  });

  it("moves a bound arrow's end off the shape, which is what binding is for", () => {
    const bound = applyBindings(
      [
        shape,
        createElement("Arrow", {
          id: "arrow",
          x1: corner.x,
          y1: corner.y,
          x2: 600,
          y2: 200,
        })!,
      ],
      "arrow",
      { start: createBinding(shape, corner, 24) },
    );

    const arrow = arrowOf(bound);
    expect(arrow.x1 === corner.x && arrow.y1 === corner.y).toBe(false);
  });
});

describe("refreshLinearElement", () => {
  it("returns the same object when nothing changed", () => {
    const resolved = refreshLinearElement(arrow(), []);
    expect(refreshLinearElement(resolved, [])).toBe(resolved);
  });

  it("keeps a straight connector aimed at the shapes it joins", () => {
    const elements = scene("straight");
    const connector = arrowOf(elements);

    expect(getLinearPath(connector)).toHaveLength(2);
    expect(
      hitTestElement(
        { x: connector.x1, y: connector.y1 },
        elements.find((element) => element.id === "a")!,
        0,
      ),
    ).toBe(false);
  });

  it("routes an elbow orthogonally and clear of both shapes", () => {
    const elements = scene("elbow");
    const connector = arrowOf(elements);
    const path = getLinearPath(connector);

    expect(path.length).toBeGreaterThan(2);
    expect(isOrthogonal(path)).toBe(true);

    for (const id of ["a", "b"]) {
      const shape = elements.find((element) => element.id === id)!;
      for (const point of path) {
        expect(hitTestElement(point, shape, 0)).toBe(false);
      }
    }
  });

  it("leaves an elbow from the middle of a side", () => {
    const elements = scene("elbow");
    const connector = arrowOf(elements);
    const from = getElementBounds(
      elements.find((element) => element.id === "a")!,
    );

    // Box A is up and to the left of box B, so the arrow leaves downwards or
    // rightwards from the centre of that side.
    const leavesRight =
      Math.abs(connector.y1 - (from.y + from.height / 2)) < 0.01;
    const leavesDown =
      Math.abs(connector.x1 - (from.x + from.width / 2)) < 0.01;

    expect(leavesRight || leavesDown).toBe(true);
  });

  it("re-routes an elbow when a bound shape moves", () => {
    const elements = scene("elbow");
    const before = getLinearPath(arrowOf(elements));

    const moved = elements.map((element) =>
      element.id === "b" ? translateElement(element, -200, 400) : element,
    );
    const after = getLinearPath(
      refreshLinearElement(arrowOf(moved), moved),
    );

    expect(after).not.toEqual(before);
    expect(isOrthogonal(after)).toBe(true);
  });

  it("bounds an elbow by its whole route, not just its ends", () => {
    const elements = scene("elbow");
    const connector = arrowOf(elements);
    const bounds = getElementBounds(connector);

    for (const point of getLinearPath(connector)) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.x - 0.01);
      expect(point.x).toBeLessThanOrEqual(bounds.x + bounds.width + 0.01);
      expect(point.y).toBeGreaterThanOrEqual(bounds.y - 0.01);
      expect(point.y).toBeLessThanOrEqual(bounds.y + bounds.height + 0.01);
    }
  });

  it("keeps a bound elbow stable when re-resolved repeatedly", () => {
    // Idempotence matters: this runs on every frame of a drag.
    let elements = scene("elbow");
    const first = getLinearPath(arrowOf(elements));

    for (let i = 0; i < 5; i += 1) {
      elements = elements.map((element) =>
        element.id === "arrow"
          ? refreshLinearElement(element as LinearShape, elements)
          : element,
      );
    }

    expect(getLinearPath(arrowOf(elements))).toEqual(first);
  });
});

describe("roundedPathD", () => {
  it("is a plain line for two points", () => {
    expect(
      roundedPathD([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe("M 0 0 L 10 0");
  });

  it("rounds a corner with a quadratic", () => {
    const d = roundedPathD(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      16,
    );

    expect(d).toContain("Q 100 0");
    // The corner itself is never visited with a straight line.
    expect(d).not.toContain("L 100 0 ");
  });

  it("shrinks the radius rather than overshooting a short segment", () => {
    const d = roundedPathD(
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
      ],
      16,
    );

    // With a 4px segment the radius caps at 2, so the curve starts at x = 2.
    expect(d).toContain("L 2 0");
  });

  it("returns nothing for a degenerate path", () => {
    expect(roundedPathD([])).toBe("");
    expect(roundedPathD([{ x: 1, y: 1 }])).toBe("");
  });
});

describe("getEndDirection", () => {
  it("follows the last segment, not the overall span", () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];

    // Ends heading straight down.
    expect(getEndDirection(path, "end")).toBeCloseTo(Math.PI / 2);
    // Starts heading back to the left.
    expect(Math.abs(getEndDirection(path, "start"))).toBeCloseTo(Math.PI);
  });
});
