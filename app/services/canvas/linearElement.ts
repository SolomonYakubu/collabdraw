/**
 * Linear elements: where their ends actually land, and what path joins them.
 *
 * A line or arrow has three sources of shape:
 *  - its two ends, which may be free or bound to a shape;
 *  - the waypoints the user dragged out of it;
 *  - for an elbow, the route computed around the shapes it connects.
 *
 * `refreshLinearElement` folds all three into the element's `route`, which is
 * then the single thing the renderer, the bounds and the hit test read.
 */
import {
  HEADING_VECTORS,
  isBindableShape,
  isLinearShape,
  type BoundingBox,
  type Heading,
  type LinearShape,
  type Point,
  type PointBinding,
  type Shape,
} from "../../types/shapes";
import {
  clamp,
  diamondPoints,
  exitBoxAlongRay,
  exitEllipseAlongRay,
  intersectSegmentWithPolygon,
  normalizeBox,
  trianglePoints,
} from "../../utils/geometry";
import {
  fromElementLocal,
  getElementBounds,
  mutateElement,
  toElementLocal,
} from "./elements";
import {
  getFacingHeadings,
  getSideAnchor,
  routeElbow,
  ROUTE_CLEARANCE,
} from "./elbowRouter";

/** Arrows never touch the shape they point at. */
export const MIN_BINDING_GAP = 4;

/** Radius of the rounded corner on an elbow. */
const CORNER_RADIUS = 16;

/** Most shapes an elbow will try to route around, for predictable cost. */
const MAX_OBSTACLES = 6;

export const pointsToFlat = (points: readonly Point[]): number[] => {
  const flat: number[] = [];
  for (const point of points) {
    flat.push(point.x, point.y);
  }
  return flat;
};

export const flatToPoints = (flat: readonly number[]): Point[] => {
  const points: Point[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    points.push({ x: flat[i], y: flat[i + 1] });
  }
  return points;
};

/** The points the user controls: both ends plus any waypoints between them. */
export const getControlPoints = (element: LinearShape): Point[] => [
  { x: element.x1, y: element.y1 },
  ...flatToPoints(element.midPoints),
  { x: element.x2, y: element.y2 },
];

/** The polyline actually drawn, falling back to the control points. */
export const getLinearPath = (element: LinearShape): Point[] =>
  element.route.length >= 4
    ? flatToPoints(element.route)
    : getControlPoints(element);

const findElement = (
  elements: readonly Shape[],
  id: string | undefined,
): Shape | null =>
  id
    ? elements.find((element) => element.id === id && !element.isDeleted) ?? null
    : null;

const getAnchorPoint = (element: Shape, focus: Point): Point => {
  const bounds = getElementBounds(element);
  return fromElementLocal(
    {
      x: bounds.x + bounds.width * (0.5 + focus.x),
      y: bounds.y + bounds.height * (0.5 + focus.y),
    },
    element,
  );
};

/**
 * Where the ray from the binding's anchor (inside the shape) towards the
 * arrow's other end crosses the shape's outline.
 */
const intersectOutline = (
  element: Shape,
  worldAnchor: Point,
  worldTowards: Point,
): Point => {
  const bounds = getElementBounds(element);

  /*
   * Solved in the shape's own frame, where its outline is axis-aligned, then
   * mapped back. That keeps one implementation per outline shape rather than a
   * rotated variant of each.
   */
  const anchor = toElementLocal(worldAnchor, element);
  const towards = toElementLocal(worldTowards, element);
  const place = (point: Point) => fromElementLocal(point, element);

  if (element.tool === "Circle") {
    return place(exitEllipseAlongRay(bounds, anchor, towards));
  }

  if (element.tool === "Diamond" || element.tool === "Triangle") {
    const polygon =
      element.tool === "Diamond"
        ? diamondPoints(bounds)
        : trianglePoints(bounds);

    // Extend the ray well past the shape so it always crosses an edge.
    const dx = towards.x - anchor.x;
    const dy = towards.y - anchor.y;
    const length = Math.hypot(dx, dy) || 1;
    const reach = bounds.width + bounds.height + length;
    const far = {
      x: anchor.x + (dx / length) * reach,
      y: anchor.y + (dy / length) * reach,
    };

    return place(intersectSegmentWithPolygon(polygon, anchor, far) ?? anchor);
  }

  return place(exitBoxAlongRay(bounds, anchor, towards));
};

/**
 * A bound endpoint for a straight or curved arrow: on the outline, aimed at the
 * spot the user pointed at, standing off by the binding's gap.
 */
export const getBoundPoint = (
  binding: PointBinding,
  boundElement: Shape,
  adjacent: Point,
): Point => {
  const anchor = getAnchorPoint(boundElement, binding.focus);
  const edge = intersectOutline(boundElement, anchor, adjacent);

  const dx = adjacent.x - edge.x;
  const dy = adjacent.y - edge.y;
  const length = Math.hypot(dx, dy);

  if (length === 0) {
    return edge;
  }

  // Never overshoot the other endpoint when the two shapes are very close.
  const offset = Math.min(Math.max(binding.gap, MIN_BINDING_GAP), length);

  return {
    x: edge.x + (dx / length) * offset,
    y: edge.y + (dy / length) * offset,
  };
};

/** Which way an arrow should leave a shape, given where its other end is. */
const headingTowards = (from: BoundingBox, target: Point): Heading => {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "down" : "up";
};

interface ResolvedEnds {
  start: Point;
  end: Point;
  startHeading: Heading | null;
  endHeading: Heading | null;
  obstacles: BoundingBox[];
}

/**
 * Resolve both ends of a linear element.
 *
 * Elbows leave a bound shape from the middle of a side, which is what makes a
 * grid of connectors line up; straight and curved arrows keep aiming at the
 * point the user bound them to.
 */
const resolveEnds = (
  element: LinearShape,
  elements: readonly Shape[],
): ResolvedEnds => {
  const startElement = findElement(elements, element.startBinding?.elementId);
  const endElement = findElement(elements, element.endBinding?.elementId);

  const waypoints = flatToPoints(element.midPoints);
  const rawStart = { x: element.x1, y: element.y1 };
  const rawEnd = { x: element.x2, y: element.y2 };

  // What each end "looks at" — the next waypoint if there is one.
  const startLooksAt = waypoints[0] ?? rawEnd;
  const endLooksAt = waypoints[waypoints.length - 1] ?? rawStart;

  const obstacles: BoundingBox[] = [];
  if (startElement) {
    obstacles.push(getElementBounds(startElement));
  }
  if (endElement) {
    obstacles.push(getElementBounds(endElement));
  }

  if (element.edgeStyle !== "elbow") {
    // Each bound end aims at the other one, so the two have to be solved
    // together. Two refinement passes converge on a stable, symmetric result;
    // a single pass would let any wobble in the raw opposite endpoint leak into
    // the answer, so nudging a bound arrow by a pixel moved it permanently.
    let start = rawStart;
    let end = rawEnd;

    const solveStart = (towards: Point) =>
      startElement && element.startBinding
        ? getBoundPoint(element.startBinding, startElement, towards)
        : rawStart;

    const solveEnd = (towards: Point) =>
      endElement && element.endBinding
        ? getBoundPoint(element.endBinding, endElement, towards)
        : rawEnd;

    for (let pass = 0; pass < 2; pass += 1) {
      start = solveStart(waypoints[0] ?? end);
      end = solveEnd(waypoints[waypoints.length - 1] ?? start);
    }

    return {
      start,
      end,
      startHeading: null,
      endHeading: null,
      obstacles,
    };
  }

  const startBox = startElement ? getElementBounds(startElement) : null;
  const endBox = endElement ? getElementBounds(endElement) : null;

  let startHeading: Heading | null = null;
  let endHeading: Heading | null = null;

  if (startBox && endBox && waypoints.length === 0) {
    // Both ends bound: pick the pair of sides that face each other.
    const facing = getFacingHeadings(startBox, endBox);
    startHeading = facing.start;
    endHeading = facing.end;
  } else {
    if (startBox) {
      startHeading = headingTowards(startBox, startLooksAt);
    }
    if (endBox) {
      endHeading = headingTowards(endBox, endLooksAt);
    }
  }

  const startGap = Math.max(element.startBinding?.gap ?? MIN_BINDING_GAP, MIN_BINDING_GAP);
  const endGap = Math.max(element.endBinding?.gap ?? MIN_BINDING_GAP, MIN_BINDING_GAP);

  return {
    start:
      startBox && startHeading
        ? getSideAnchor(startBox, startHeading, startGap)
        : rawStart,
    end:
      endBox && endHeading ? getSideAnchor(endBox, endHeading, endGap) : rawEnd,
    startHeading,
    endHeading,
    obstacles,
  };
};

/**
 * Other shapes worth routing around: bindable elements that sit inside the
 * rectangle spanned by the two ends. Cheap to test and enough to make a
 * connector step around something in its way.
 */
const collectObstacles = (
  element: LinearShape,
  elements: readonly Shape[],
  ends: ResolvedEnds,
): BoundingBox[] => {
  const obstacles = [...ends.obstacles];

  if (obstacles.length >= MAX_OBSTACLES) {
    return obstacles.slice(0, MAX_OBSTACLES);
  }

  const corridor = normalizeBox(ends.start.x, ends.start.y, ends.end.x, ends.end.y);
  const boundIds = new Set(
    [element.startBinding?.elementId, element.endBinding?.elementId].filter(
      (id): id is string => Boolean(id),
    ),
  );

  for (const candidate of elements) {
    if (obstacles.length >= MAX_OBSTACLES) {
      break;
    }

    if (
      candidate.isDeleted ||
      candidate.id === element.id ||
      boundIds.has(candidate.id) ||
      !isBindableShape(candidate) ||
      // A label inside a shape is not an obstacle in its own right.
      (candidate.tool === "Text" && candidate.containerId)
    ) {
      continue;
    }

    const bounds = getElementBounds(candidate);
    const overlapsCorridor =
      bounds.x < corridor.x + corridor.width &&
      bounds.x + bounds.width > corridor.x &&
      bounds.y < corridor.y + corridor.height &&
      bounds.y + bounds.height > corridor.y;

    if (overlapsCorridor) {
      obstacles.push(bounds);
    }
  }

  return obstacles;
};

/**
 * Recompute an element's ends and route. Call after anything that can change
 * its shape: moving it, moving a shape it is bound to, binding, unbinding, or
 * editing a waypoint.
 */
export const refreshLinearElement = (
  element: LinearShape,
  elements: readonly Shape[],
): LinearShape => {
  const ends = resolveEnds(element, elements);
  const waypoints = flatToPoints(element.midPoints);

  let path: Point[];

  if (element.edgeStyle === "elbow") {
    const obstacles = collectObstacles(element, elements, ends);

    if (waypoints.length === 0) {
      path = routeElbow({
        start: ends.start,
        end: ends.end,
        startHeading: ends.startHeading,
        endHeading: ends.endHeading,
        obstacles,
      });
    } else {
      // Route each leg in turn so waypoints still steer an elbow.
      const stops = [ends.start, ...waypoints, ends.end];
      path = [];

      for (let i = 0; i + 1 < stops.length; i += 1) {
        const leg = routeElbow({
          start: stops[i],
          end: stops[i + 1],
          startHeading: i === 0 ? ends.startHeading : null,
          endHeading: i + 2 === stops.length ? ends.endHeading : null,
          obstacles,
        });

        path.push(...(i === 0 ? leg : leg.slice(1)));
      }
    }
  } else {
    path = [ends.start, ...waypoints, ends.end];
  }

  const route = pointsToFlat(path);
  const bounds = boundsOfPath(route);

  const unchanged =
    element.x1 === ends.start.x &&
    element.y1 === ends.start.y &&
    element.x2 === ends.end.x &&
    element.y2 === ends.end.y &&
    element.route.length === route.length &&
    route.every((value, index) => Math.abs(element.route[index] - value) < 0.01);

  if (unchanged) {
    return element;
  }

  return mutateElement(element, {
    x1: ends.start.x,
    y1: ends.start.y,
    x2: ends.end.x,
    y2: ends.end.y,
    route,
    ...bounds,
  });
};

/** Bounding box of a flat point list, never negative. */
export const boundsOfPath = (flat: readonly number[]): BoundingBox => {
  if (flat.length < 2) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let i = 0; i + 1 < flat.length; i += 2) {
    minX = Math.min(minX, flat[i]);
    maxX = Math.max(maxX, flat[i]);
    minY = Math.min(minY, flat[i + 1]);
    maxY = Math.max(maxY, flat[i + 1]);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/** Refresh every linear element in a list that needs it. */
export const refreshLinearElements = (
  elements: readonly Shape[],
  ids: ReadonlySet<string>,
): Shape[] =>
  elements.map((element) =>
    ids.has(element.id) && isLinearShape(element)
      ? refreshLinearElement(element, elements)
      : element,
  );

/* ------------------------------------------------------------------ *
 * Waypoints
 * ------------------------------------------------------------------ */

/** Midpoints of each control segment: where a new waypoint can be pulled out. */
export const getSegmentMidpoints = (element: LinearShape): Point[] => {
  const controls = getControlPoints(element);
  const midpoints: Point[] = [];

  for (let i = 0; i + 1 < controls.length; i += 1) {
    midpoints.push({
      x: (controls[i].x + controls[i + 1].x) / 2,
      y: (controls[i].y + controls[i + 1].y) / 2,
    });
  }

  return midpoints;
};

export const insertWaypoint = (
  element: LinearShape,
  segmentIndex: number,
  point: Point,
): LinearShape => {
  const waypoints = flatToPoints(element.midPoints);
  const index = clamp(segmentIndex, 0, waypoints.length);
  waypoints.splice(index, 0, point);

  return mutateElement(element, { midPoints: pointsToFlat(waypoints) });
};

export const moveWaypoint = (
  element: LinearShape,
  index: number,
  point: Point,
): LinearShape => {
  const waypoints = flatToPoints(element.midPoints);

  if (index < 0 || index >= waypoints.length) {
    return element;
  }

  waypoints[index] = point;
  return mutateElement(element, { midPoints: pointsToFlat(waypoints) });
};

export const removeWaypoint = (
  element: LinearShape,
  index: number,
): LinearShape => {
  const waypoints = flatToPoints(element.midPoints);

  if (index < 0 || index >= waypoints.length) {
    return element;
  }

  waypoints.splice(index, 1);
  return mutateElement(element, { midPoints: pointsToFlat(waypoints) });
};

/* ------------------------------------------------------------------ *
 * Rendering geometry
 * ------------------------------------------------------------------ */

/**
 * An SVG path for a polyline with rounded corners, so an elbow bends instead of
 * turning a hard right angle. The radius shrinks on short segments, which keeps
 * tight routes from folding over themselves.
 */
export const roundedPathD = (
  points: readonly Point[],
  radius = CORNER_RADIUS,
): string => {
  if (points.length < 2) {
    return "";
  }

  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  const parts = [`M ${points[0].x} ${points[0].y}`];

  for (let i = 1; i < points.length - 1; i += 1) {
    const previous = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];

    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);

    // Never eat more than half of either adjoining segment.
    const r = Math.min(radius, inLength / 2, outLength / 2);

    if (r < 0.5) {
      parts.push(`L ${corner.x} ${corner.y}`);
      continue;
    }

    const inUnit = {
      x: (corner.x - previous.x) / (inLength || 1),
      y: (corner.y - previous.y) / (inLength || 1),
    };
    const outUnit = {
      x: (next.x - corner.x) / (outLength || 1),
      y: (next.y - corner.y) / (outLength || 1),
    };

    const before = { x: corner.x - inUnit.x * r, y: corner.y - inUnit.y * r };
    const after = { x: corner.x + outUnit.x * r, y: corner.y + outUnit.y * r };

    parts.push(`L ${before.x} ${before.y}`);
    parts.push(`Q ${corner.x} ${corner.y} ${after.x} ${after.y}`);
  }

  const last = points[points.length - 1];
  parts.push(`L ${last.x} ${last.y}`);

  return parts.join(" ");
};

/** Direction of the final segment, for pointing an arrowhead. */
export const getEndDirection = (
  points: readonly Point[],
  which: "start" | "end",
): number => {
  if (points.length < 2) {
    return 0;
  }

  if (which === "end") {
    const tip = points[points.length - 1];
    const before = points[points.length - 2];
    return Math.atan2(tip.y - before.y, tip.x - before.x);
  }

  const tip = points[0];
  const after = points[1];
  return Math.atan2(tip.y - after.y, tip.x - after.x);
};

/** Unit vector for a heading, exposed for callers that need it. */
export const headingVector = (heading: Heading): Point =>
  HEADING_VECTORS[heading];

export { ROUTE_CLEARANCE };
