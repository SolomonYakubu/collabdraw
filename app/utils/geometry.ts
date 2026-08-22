/**
 * Pure geometry helpers.
 *
 * Everything here is side-effect free and unit-testable: no canvas, no React,
 * no element model beyond plain boxes and points.
 */
import type { BoundingBox, Point } from "../types/shapes";

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const distance = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(bx - ax, by - ay);

/** Shortest distance from a point to a line segment. */
export const distanceToSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return distance(px, py, ax, ay);
  }

  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);
  return distance(px, py, ax + t * dx, ay + t * dy);
};

/** Shortest distance from a point to a closed or open polyline. */
export const distanceToPolyline = (
  px: number,
  py: number,
  points: readonly number[],
  closed = false,
): number => {
  if (points.length < 4) {
    return points.length >= 2
      ? distance(px, py, points[0], points[1])
      : Number.POSITIVE_INFINITY;
  }

  let min = Number.POSITIVE_INFINITY;

  for (let i = 0; i + 3 < points.length; i += 2) {
    min = Math.min(
      min,
      distanceToSegment(px, py, points[i], points[i + 1], points[i + 2], points[i + 3]),
    );
  }

  if (closed) {
    min = Math.min(
      min,
      distanceToSegment(
        px,
        py,
        points[points.length - 2],
        points[points.length - 1],
        points[0],
        points[1],
      ),
    );
  }

  return min;
};

export const isPointInBox = (
  px: number,
  py: number,
  box: BoundingBox,
  margin = 0,
): boolean =>
  px >= box.x - margin &&
  px <= box.x + box.width + margin &&
  py >= box.y - margin &&
  py <= box.y + box.height + margin;

/** Distance from a point to the outline of an axis-aligned rectangle. */
export const distanceToBoxOutline = (
  px: number,
  py: number,
  box: BoundingBox,
): number => {
  const { x, y, width, height } = box;
  return Math.min(
    distanceToSegment(px, py, x, y, x + width, y),
    distanceToSegment(px, py, x + width, y, x + width, y + height),
    distanceToSegment(px, py, x + width, y + height, x, y + height),
    distanceToSegment(px, py, x, y + height, x, y),
  );
};

export const isPointInEllipse = (
  px: number,
  py: number,
  box: BoundingBox,
): boolean => {
  const rx = box.width / 2;
  const ry = box.height / 2;
  if (rx <= 0 || ry <= 0) {
    return false;
  }
  const nx = (px - (box.x + rx)) / rx;
  const ny = (py - (box.y + ry)) / ry;
  return nx * nx + ny * ny <= 1;
};

/**
 * Distance from a point to an ellipse outline.
 *
 * Uses the standard iterative approximation: good to well under a pixel after a
 * handful of steps, and far cheaper than solving the quartic exactly.
 */
export const distanceToEllipseOutline = (
  px: number,
  py: number,
  box: BoundingBox,
): number => {
  const rx = Math.abs(box.width / 2);
  const ry = Math.abs(box.height / 2);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  if (rx === 0 || ry === 0) {
    return distanceToSegment(px, py, box.x, box.y, box.x + box.width, box.y + box.height);
  }

  const localX = Math.abs(px - cx);
  const localY = Math.abs(py - cy);

  let t = Math.PI / 4;

  for (let i = 0; i < 4; i += 1) {
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);

    const ex = ((ry * ry - rx * rx) * Math.cos(t) ** 3) / rx;
    const ey = ((rx * rx - ry * ry) * Math.sin(t) ** 3) / ry;

    const rxv = x - ex;
    const ryv = y - ey;
    const qx = localX - ex;
    const qy = localY - ey;

    const r = Math.hypot(ryv, rxv);
    const q = Math.hypot(qy, qx);

    t += Math.asin(clamp((rxv * qy - ryv * qx) / (r * q || 1), -1, 1)) * (r / (q || 1));
    t = clamp(t, 0, Math.PI / 2);
  }

  return distance(localX, localY, rx * Math.cos(t), ry * Math.sin(t));
};

/** The four corners of a diamond inscribed in `box`, as a flat point list. */
export const diamondPoints = (box: BoundingBox): number[] => {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return [
    cx,
    box.y,
    box.x + box.width,
    cy,
    cx,
    box.y + box.height,
    box.x,
    cy,
  ];
};

/**
 * The three corners of a triangle inscribed in `box`, apex at the top centre and
 * base along the bottom, as a flat point list.
 */
export const trianglePoints = (box: BoundingBox): number[] => [
  box.x + box.width / 2,
  box.y,
  box.x + box.width,
  box.y + box.height,
  box.x,
  box.y + box.height,
];

/** Rotate a point about a centre. Angles are radians, clockwise on screen. */
export const rotatePoint = (
  point: Point,
  center: Point,
  angle: number,
): Point => {
  if (angle === 0) {
    return { ...point };
  }

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;

  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
};

/** Rotate a free vector, with no centre involved. */
export const rotateVector = (vector: Point, angle: number): Point => {
  if (angle === 0) {
    return { ...vector };
  }

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  };
};

export const boxCenter = (box: BoundingBox): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/** The four corners of a box after rotation, as a flat point list. */
export const rotatedBoxCorners = (
  box: BoundingBox,
  angle: number,
): number[] => {
  const center = boxCenter(box);
  const right = box.x + box.width;
  const bottom = box.y + box.height;

  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: right, y: box.y },
    { x: right, y: bottom },
    { x: box.x, y: bottom },
  ];

  const flat: number[] = [];
  for (const corner of corners) {
    const rotated = rotatePoint(corner, center, angle);
    flat.push(rotated.x, rotated.y);
  }

  return flat;
};

/**
 * The axis-aligned box that contains a rotated box. Used wherever a screen-space
 * rectangle is needed — culling, marquee selection — as opposed to the element's
 * own unrotated geometry.
 */
export const rotatedBoxAABB = (
  box: BoundingBox,
  angle: number,
): BoundingBox => {
  if (angle === 0) {
    return { ...box };
  }

  const flat = rotatedBoxCorners(box, angle);
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

/** Normalise an angle into [0, 2π). */
export const normalizeAngle = (angle: number): number => {
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
};

/** Snap an angle to the nearest increment, for shift-rotation. */
export const snapAngleValue = (angle: number, stepDegrees = 15): number => {
  const step = (stepDegrees * Math.PI) / 180;
  return Math.round(angle / step) * step;
};

/** Even-odd point-in-polygon test over a flat [x, y, x, y, ...] list. */
export const isPointInPolygon = (
  px: number,
  py: number,
  points: readonly number[],
): boolean => {
  let inside = false;

  for (
    let i = 0, j = points.length - 2;
    i < points.length;
    j = i, i += 2
  ) {
    const xi = points[i];
    const yi = points[i + 1];
    const xj = points[j];
    const yj = points[j + 1];

    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi || Number.EPSILON) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
};

export const boxesOverlap = (a: BoundingBox, b: BoundingBox): boolean =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

export const boxContainsBox = (outer: BoundingBox, inner: BoundingBox): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** Normalise a drag rectangle so width/height are never negative. */
export const normalizeBox = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): BoundingBox => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  width: Math.abs(x2 - x1),
  height: Math.abs(y2 - y1),
});

export const unionBoxes = (boxes: readonly BoundingBox[]): BoundingBox | null => {
  if (boxes.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/** Snap an angle to the nearest `stepDegrees` increment. Used for shift+draw. */
export const snapAngle = (
  from: Point,
  to: Point,
  stepDegrees = 15,
): Point => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);

  if (length === 0) {
    return { ...to };
  }

  const step = (stepDegrees * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;

  return {
    x: from.x + Math.cos(angle) * length,
    y: from.y + Math.sin(angle) * length,
  };
};

/**
 * Where a ray leaving `from` towards `target` exits an axis-aligned box.
 * `from` is expected to be inside the box.
 */
export const exitBoxAlongRay = (
  box: BoundingBox,
  from: Point,
  target: Point,
): Point => {
  const dx = target.x - from.x;
  const dy = target.y - from.y;

  if (dx === 0 && dy === 0) {
    return { ...from };
  }

  const right = box.x + box.width;
  const bottom = box.y + box.height;

  // Distance along the ray to each candidate edge; the nearest one wins.
  let t = Number.POSITIVE_INFINITY;

  if (dx > 0) {
    t = Math.min(t, (right - from.x) / dx);
  } else if (dx < 0) {
    t = Math.min(t, (box.x - from.x) / dx);
  }

  if (dy > 0) {
    t = Math.min(t, (bottom - from.y) / dy);
  } else if (dy < 0) {
    t = Math.min(t, (box.y - from.y) / dy);
  }

  if (!Number.isFinite(t) || t < 0) {
    return { ...from };
  }

  return { x: from.x + dx * t, y: from.y + dy * t };
};

/**
 * Where a ray leaving `from` towards `target` exits an ellipse inscribed in
 * `box`. `from` is expected to be inside the ellipse.
 */
export const exitEllipseAlongRay = (
  box: BoundingBox,
  from: Point,
  target: Point,
): Point => {
  const rx = box.width / 2;
  const ry = box.height / 2;

  if (rx === 0 || ry === 0) {
    return { ...from };
  }

  const dx = target.x - from.x;
  const dy = target.y - from.y;

  if (dx === 0 && dy === 0) {
    return { ...from };
  }

  // Work in the unit circle: solve |o + t·u| = 1.
  const ox = (from.x - (box.x + rx)) / rx;
  const oy = (from.y - (box.y + ry)) / ry;
  const ux = dx / rx;
  const uy = dy / ry;

  const a = ux * ux + uy * uy;
  const b = 2 * (ox * ux + oy * uy);
  const c = ox * ox + oy * oy - 1;
  const discriminant = b * b - 4 * a * c;

  if (a === 0 || discriminant < 0) {
    return { ...from };
  }

  // With `from` inside, the roots straddle zero; take the forward one.
  const t = (-b + Math.sqrt(discriminant)) / (2 * a);

  if (!(t > 0)) {
    return { ...from };
  }

  return { x: from.x + dx * t, y: from.y + dy * t };
};

/** Where a segment crosses a polygon outline, nearest to the segment start. */
export const intersectSegmentWithPolygon = (
  points: readonly number[],
  from: Point,
  to: Point,
): Point | null => {
  let closest: Point | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const hit = intersectSegments(
      from,
      to,
      { x: points[j], y: points[j + 1] },
      { x: points[i], y: points[i + 1] },
    );

    if (hit) {
      const d = distance(from.x, from.y, hit.x, hit.y);
      if (d < closestDistance) {
        closestDistance = d;
        closest = hit;
      }
    }
  }

  return closest;
};

export const intersectSegments = (
  a1: Point,
  a2: Point,
  b1: Point,
  b2: Point,
): Point | null => {
  const denominator =
    (b2.y - b1.y) * (a2.x - a1.x) - (b2.x - b1.x) * (a2.y - a1.y);

  if (denominator === 0) {
    return null;
  }

  const ua =
    ((b2.x - b1.x) * (a1.y - b1.y) - (b2.y - b1.y) * (a1.x - b1.x)) / denominator;
  const ub =
    ((a2.x - a1.x) * (a1.y - b1.y) - (a2.y - a1.y) * (a1.x - b1.x)) / denominator;

  if (ua < 0 || ua > 1 || ub < 0 || ub > 1) {
    return null;
  }

  return { x: a1.x + ua * (a2.x - a1.x), y: a1.y + ua * (a2.y - a1.y) };
};

/**
 * Ramer-Douglas-Peucker simplification for freehand strokes, over a flat
 * coordinate list. Keeps the visual shape while cutting point counts by ~80%.
 */
export const simplifyPoints = (
  points: readonly number[],
  tolerance = 0.6,
): number[] => {
  if (points.length <= 6) {
    return [...points];
  }

  const keep = new Uint8Array(points.length / 2);
  keep[0] = 1;
  keep[points.length / 2 - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length / 2 - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDistance = 0;
    let index = -1;

    for (let i = first + 1; i < last; i += 1) {
      const d = distanceToSegment(
        points[i * 2],
        points[i * 2 + 1],
        points[first * 2],
        points[first * 2 + 1],
        points[last * 2],
        points[last * 2 + 1],
      );

      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }

    if (index !== -1 && maxDistance > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const simplified: number[] = [];
  for (let i = 0; i < keep.length; i += 1) {
    if (keep[i]) {
      simplified.push(points[i * 2], points[i * 2 + 1]);
    }
  }

  return simplified;
};
