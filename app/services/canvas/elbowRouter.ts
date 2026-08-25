/**
 * Orthogonal ("elbow") routing.
 *
 * Given two endpoints, the side each one leaves from, and the shapes that must
 * be avoided, produce a right-angled path that goes around the obstacles rather
 * than through them.
 *
 * The approach is the standard one for diagram connectors: build a sparse grid
 * from the interesting coordinates (obstacle edges plus their clearance, the
 * endpoints, and the corridor between the obstacles), then A* across it with a
 * penalty for turning. A sparse grid keeps this tiny — a couple of hundred
 * nodes at most — so it comfortably runs inside a pointer-move.
 */
import {
  HEADING_VECTORS,
  type BoundingBox,
  type Heading,
  type Point,
} from "../../types/shapes";

/** How far a route stands off from an obstacle. */
export const ROUTE_CLEARANCE = 20;

/** Cost added for each direction change, in world units. */
const TURN_PENALTY = 40;

export interface ElbowRouteRequest {
  start: Point;
  end: Point;
  /** Side the path must leave the start from, if the end is bound. */
  startHeading?: Heading | null;
  endHeading?: Heading | null;
  /** Boxes the path should not cross. */
  obstacles?: readonly BoundingBox[];
  clearance?: number;
}

const inflate = (box: BoundingBox, by: number): BoundingBox => ({
  x: box.x - by,
  y: box.y - by,
  width: box.width + by * 2,
  height: box.height + by * 2,
});

const isInside = (point: Point, box: BoundingBox): boolean =>
  point.x > box.x &&
  point.x < box.x + box.width &&
  point.y > box.y &&
  point.y < box.y + box.height;

/** Whether an axis-aligned segment passes through a box. */
const segmentCrossesBox = (a: Point, b: Point, box: BoundingBox): boolean => {
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;

  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);

  // Strict comparisons: a segment running exactly along an edge is allowed,
  // which is what lets routes hug the clearance boundary.
  return maxX > left && minX < right && maxY > top && minY < bottom;
};

const uniqueSorted = (values: number[]): number[] => {
  const sorted = [
    ...new Set(values.map((value) => Math.round(value * 100) / 100)),
  ];
  sorted.sort((a, b) => a - b);
  return sorted;
};

/** Push a point out from a shape along its heading, to start the route cleanly. */
const dongle = (
  point: Point,
  heading: Heading | null | undefined,
  by: number,
): Point => {
  if (!heading) {
    return { ...point };
  }
  const vector = HEADING_VECTORS[heading];
  return { x: point.x + vector.x * by, y: point.y + vector.y * by };
};

interface GridNode {
  x: number;
  y: number;
  /** Index into the coordinate arrays. */
  ix: number;
  iy: number;
}

const key = (ix: number, iy: number): number => ix * 10_000 + iy;

/**
 * A* over the sparse grid. Returns the interior waypoints, or null if the
 * endpoints cannot be joined without crossing an obstacle.
 */
const search = (
  xs: number[],
  ys: number[],
  from: GridNode,
  to: GridNode,
  blocked: readonly BoundingBox[],
): Point[] | null => {
  const passable = (a: Point, b: Point): boolean =>
    !blocked.some((box) => segmentCrossesBox(a, b, box));

  const heuristic = (node: GridNode): number =>
    Math.abs(node.x - to.x) + Math.abs(node.y - to.y);

  const startKey = key(from.ix, from.iy);
  const goalKey = key(to.ix, to.iy);

  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>([[startKey, 0]]);
  const open: Array<{ node: GridNode; f: number }> = [
    { node: from, f: heuristic(from) },
  ];
  const closed = new Set<number>();

  while (open.length > 0) {
    // The grid is small enough that a linear scan beats a heap.
    let bestIndex = 0;
    for (let i = 1; i < open.length; i += 1) {
      if (open[i].f < open[bestIndex].f) {
        bestIndex = i;
      }
    }

    const { node } = open.splice(bestIndex, 1)[0];
    const nodeKey = key(node.ix, node.iy);

    if (nodeKey === goalKey) {
      // Walk the parents back to the start.
      const path: Point[] = [];
      let cursor: number | undefined = nodeKey;
      while (cursor !== undefined) {
        const ix = Math.floor(cursor / 10_000);
        const iy = cursor % 10_000;
        path.push({ x: xs[ix], y: ys[iy] });
        cursor = cameFrom.get(cursor);
      }
      return path.reverse();
    }

    if (closed.has(nodeKey)) {
      continue;
    }
    closed.add(nodeKey);

    const parentKey = cameFrom.get(nodeKey);
    const parentIsHorizontal =
      parentKey === undefined
        ? null
        : Math.floor(parentKey / 10_000) !== node.ix;

    const neighbours: GridNode[] = [];
    if (node.ix > 0) {
      neighbours.push({
        ix: node.ix - 1,
        iy: node.iy,
        x: xs[node.ix - 1],
        y: node.y,
      });
    }
    if (node.ix < xs.length - 1) {
      neighbours.push({
        ix: node.ix + 1,
        iy: node.iy,
        x: xs[node.ix + 1],
        y: node.y,
      });
    }
    if (node.iy > 0) {
      neighbours.push({
        ix: node.ix,
        iy: node.iy - 1,
        x: node.x,
        y: ys[node.iy - 1],
      });
    }
    if (node.iy < ys.length - 1) {
      neighbours.push({
        ix: node.ix,
        iy: node.iy + 1,
        x: node.x,
        y: ys[node.iy + 1],
      });
    }

    for (const neighbour of neighbours) {
      const neighbourKey = key(neighbour.ix, neighbour.iy);

      if (closed.has(neighbourKey) || !passable(node, neighbour)) {
        continue;
      }

      const movingHorizontally = neighbour.ix !== node.ix;
      const turned =
        parentIsHorizontal !== null &&
        parentIsHorizontal !== movingHorizontally;

      const tentative =
        (gScore.get(nodeKey) ?? Number.POSITIVE_INFINITY) +
        Math.abs(neighbour.x - node.x) +
        Math.abs(neighbour.y - node.y) +
        (turned ? TURN_PENALTY : 0);

      if (tentative < (gScore.get(neighbourKey) ?? Number.POSITIVE_INFINITY)) {
        cameFrom.set(neighbourKey, nodeKey);
        gScore.set(neighbourKey, tentative);
        open.push({ node: neighbour, f: tentative + heuristic(neighbour) });
      }
    }
  }

  return null;
};

/** Drop points that sit on the straight line between their neighbours. */
export const simplifyOrthogonalPath = (points: readonly Point[]): Point[] => {
  const result: Point[] = [];

  for (const point of points) {
    const last = result[result.length - 1];

    // Skip duplicates.
    if (
      last &&
      Math.abs(last.x - point.x) < 0.01 &&
      Math.abs(last.y - point.y) < 0.01
    ) {
      continue;
    }

    result.push({ ...point });

    while (result.length >= 3) {
      const [a, b, c] = result.slice(-3);
      const collinear =
        (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) ||
        (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01);

      if (!collinear) {
        break;
      }

      result.splice(result.length - 2, 1);
    }
  }

  return result;
};

/**
 * A simple orthogonal path between two points, used when there is nothing to
 * route around or when the search cannot find a way through.
 *
 * The bend is chosen so the path never doubles back through the point it just
 * left: once a route has stood off from a shape along its heading, turning
 * straight back would retrace that offset, and simplification would then
 * collapse the two into a segment heading the wrong way out of the shape.
 */
const directElbow = (
  start: Point,
  end: Point,
  startHeading: Heading | null | undefined,
): Point[] => {
  if (Math.abs(start.x - end.x) < 0.01 || Math.abs(start.y - end.y) < 0.01) {
    return [start, end];
  }

  if (!startHeading) {
    // No constraint: bend along the longer axis first, which reads as natural.
    const corner =
      Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
        ? { x: end.x, y: start.y }
        : { x: start.x, y: end.y };
    return [start, corner, end];
  }

  const vector = HEADING_VECTORS[startHeading];
  const vertical = vector.x === 0;

  // Does carrying on in the heading direction actually get us closer?
  const makesProgress = vertical
    ? vector.y * (end.y - start.y) > 0
    : vector.x * (end.x - start.x) > 0;

  const corner =
    vertical === makesProgress
      ? { x: start.x, y: end.y }
      : { x: end.x, y: start.y };

  return [start, corner, end];
};

/**
 * Route an orthogonal path from `start` to `end`, around `obstacles`.
 * Always returns at least the two endpoints.
 */
export const routeElbow = ({
  start,
  end,
  startHeading,
  endHeading,
  obstacles = [],
  clearance = ROUTE_CLEARANCE,
}: ElbowRouteRequest): Point[] => {
  const startDongle = dongle(start, startHeading, clearance);
  const endDongle = dongle(end, endHeading, clearance);

  if (obstacles.length === 0) {
    return simplifyOrthogonalPath([
      start,
      startDongle,
      ...directElbow(startDongle, endDongle, startHeading),
      endDongle,
      end,
    ]);
  }

  // Obstacles are blocked at their real size; the grid lines sit a clearance
  // away, so routes never graze a shape.
  const rawBlocked = obstacles.map((box) => inflate(box, 1));
  const padded = obstacles.map((box) => inflate(box, clearance));

  // Exclude any obstacle that encloses either dongle so A* search is never
  // blocked from finding a valid path around all remaining obstacles.
  const blocked = rawBlocked.filter(
    (box) => !isInside(startDongle, box) && !isInside(endDongle, box),
  );

  const xs: number[] = [startDongle.x, endDongle.x];
  const ys: number[] = [startDongle.y, endDongle.y];

  for (const box of padded) {
    xs.push(box.x, box.x + box.width, box.x + box.width / 2);
    ys.push(box.y, box.y + box.height, box.y + box.height / 2);
  }

  // Lanes through the gaps between obstacles, which is what makes a route
  // through crowded shapes look deliberate.
  for (let i = 0; i < padded.length; i += 1) {
    for (let j = i + 1; j < padded.length; j += 1) {
      xs.push((padded[i].x + padded[i].width + padded[j].x) / 2);
      xs.push((padded[j].x + padded[j].width + padded[i].x) / 2);
      ys.push((padded[i].y + padded[i].height + padded[j].y) / 2);
      ys.push((padded[j].y + padded[j].height + padded[i].y) / 2);
    }
  }

  const gridX = uniqueSorted(xs);
  const gridY = uniqueSorted(ys);

  const findNode = (point: Point): GridNode => {
    let ix = 0;
    let iy = 0;
    for (let i = 1; i < gridX.length; i += 1) {
      if (Math.abs(gridX[i] - point.x) < Math.abs(gridX[ix] - point.x)) {
        ix = i;
      }
    }
    for (let i = 1; i < gridY.length; i += 1) {
      if (Math.abs(gridY[i] - point.y) < Math.abs(gridY[iy] - point.y)) {
        iy = i;
      }
    }
    return { ix, iy, x: gridX[ix], y: gridY[iy] };
  };

  const fromNode = findNode(startDongle);
  const toNode = findNode(endDongle);

  // A dongle sitting inside another shape cannot be routed from; fall back.
  const dongleTrapped =
    blocked.some((box) => isInside(startDongle, box)) ||
    blocked.some((box) => isInside(endDongle, box));

  const interior = dongleTrapped
    ? null
    : search(gridX, gridY, fromNode, toNode, blocked);

  if (!interior) {
    return simplifyOrthogonalPath([
      start,
      startDongle,
      ...directElbow(startDongle, endDongle, startHeading),
      endDongle,
      end,
    ]);
  }

  return simplifyOrthogonalPath([
    start,
    startDongle,
    ...interior,
    endDongle,
    end,
  ]);
};

/**
 * The side of `box` that `point` is closest to. Used to decide which way an
 * arrow should leave a shape it is bound to.
 */
export const getHeadingForPointOnBox = (
  point: Point,
  box: BoundingBox,
): Heading => {
  const left = Math.abs(point.x - box.x);
  const right = Math.abs(point.x - (box.x + box.width));
  const top = Math.abs(point.y - box.y);
  const bottom = Math.abs(point.y - (box.y + box.height));

  const nearest = Math.min(left, right, top, bottom);

  if (nearest === top) {
    return "up";
  }
  if (nearest === bottom) {
    return "down";
  }
  return nearest === left ? "left" : "right";
};

/** The midpoint of one side of a box, offset outwards by `gap`. */
export const getSideAnchor = (
  box: BoundingBox,
  heading: Heading,
  gap: number,
): Point => {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  switch (heading) {
    case "up":
      return { x: cx, y: box.y - gap };
    case "down":
      return { x: cx, y: box.y + box.height + gap };
    case "left":
      return { x: box.x - gap, y: cy };
    case "right":
    default:
      return { x: box.x + box.width + gap, y: cy };
  }
};

/**
 * Pick the sides two boxes should connect through, based on how they are
 * arranged. Preferring the dominant axis is what stops elbows from taking
 * absurd detours around shapes that are plainly side by side.
 */
export const getFacingHeadings = (
  from: BoundingBox,
  to: BoundingBox,
): { start: Heading; end: Heading } => {
  const fromCenter = {
    x: from.x + from.width / 2,
    y: from.y + from.height / 2,
  };
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };

  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;

  // Gaps along each axis; a negative gap means the boxes overlap on that axis.
  const gapX =
    dx >= 0 ? to.x - (from.x + from.width) : from.x - (to.x + to.width);
  const gapY =
    dy >= 0 ? to.y - (from.y + from.height) : from.y - (to.y + to.height);

  // If the boxes overlap along one axis, connect across the axis where they are separated.
  if (gapX < 0 && gapY >= 0) {
    return dy >= 0
      ? { start: "down", end: "up" }
      : { start: "up", end: "down" };
  }
  if (gapY < 0 && gapX >= 0) {
    return dx >= 0
      ? { start: "right", end: "left" }
      : { start: "left", end: "right" };
  }

  // When separated on both axes, prefer vertical connections (down->up / up->down)
  // when vertical tier distance is significant, matching top-to-bottom diagram flow.
  if (gapY >= 0 && gapX >= 0) {
    if (gapY >= 30 && gapX < gapY * 2.5) {
      return dy >= 0
        ? { start: "down", end: "up" }
        : { start: "up", end: "down" };
    }
    return dx >= 0
      ? { start: "right", end: "left" }
      : { start: "left", end: "right" };
  }

  // Overlapping or diagonal fallback: compare center deltas
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy >= 0
      ? { start: "down", end: "up" }
      : { start: "up", end: "down" };
  }
  return dx >= 0
    ? { start: "right", end: "left" }
    : { start: "left", end: "right" };
};
