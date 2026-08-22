/**
 * Snapping a point to the significant points of nearby elements.
 *
 * Drawing a cube means joining corner to corner, and that needs the endpoint to
 * land *exactly* on a vertex — not near it. Alignment guides handle whole
 * elements lining up; this handles a single point being placed on another
 * element's corner, edge midpoint, centre, or on the end of another line.
 */
import {
  isLinearShape,
  type Point,
  type Shape,
} from "../../types/shapes";
import { diamondPoints, trianglePoints } from "../../utils/geometry";
import {
  fromElementLocal,
  getElementBounds,
  getRotatedBounds,
} from "./elements";
import { getControlPoints } from "./linearElement";

/** How close the pointer has to be for a point to grab it, in screen pixels. */
export const SNAP_POINT_THRESHOLD_PX = 12;

/** What kind of point was snapped to, so the feedback can say why. */
export type SnapKind = "corner" | "midpoint" | "center" | "endpoint";

export interface SnapCandidate extends Point {
  kind: SnapKind;
}

export interface SnapResult {
  point: Point;
  /** Null when nothing was close enough and the pointer position stands. */
  snappedTo: SnapCandidate | null;
}

/**
 * The points of one element worth snapping to.
 *
 * Freehand strokes contribute only their two ends: every sampled point would
 * make the whole canvas sticky.
 */
const getElementSnapPoints = (element: Shape): SnapCandidate[] => {
  if (element.isDeleted) {
    return [];
  }

  // Candidates are derived in the element's own frame, then placed in the world,
  // so a rotated shape's corners are wherever they actually appear.
  const place = (points: SnapCandidate[]): SnapCandidate[] =>
    element.angle === 0
      ? points
      : points.map((point) => ({
          ...fromElementLocal(point, element),
          kind: point.kind,
        }));

  if (isLinearShape(element)) {
    const controls = getControlPoints(element);
    const points: SnapCandidate[] = controls.map((point) => ({
      ...point,
      kind: "endpoint" as const,
    }));

    // The middle of a two-point line is a useful place to meet.
    if (controls.length === 2) {
      points.push({
        x: (controls[0].x + controls[1].x) / 2,
        y: (controls[0].y + controls[1].y) / 2,
        kind: "midpoint",
      });
    }

    return place(points);
  }

  if (element.tool === "Freehand") {
    const { points } = element;

    if (points.length < 2) {
      return [];
    }

    return place([
      { x: points[0], y: points[1], kind: "endpoint" },
      {
        x: points[points.length - 2],
        y: points[points.length - 1],
        kind: "endpoint",
      },
    ]);
  }

  const bounds = getElementBounds(element);
  const { x, y, width, height } = bounds;
  const right = x + width;
  const bottom = y + height;
  const centerX = x + width / 2;
  const centerY = y + height / 2;

  // A diamond's and a triangle's corners are their own points, not their
  // bounding box's, and their edge midpoints follow from those.
  if (element.tool === "Diamond" || element.tool === "Triangle") {
    const flat =
      element.tool === "Diamond" ? diamondPoints(bounds) : trianglePoints(bounds);
    const points: SnapCandidate[] = [];
    const count = flat.length / 2;

    for (let i = 0; i < count; i += 1) {
      const next = (i + 1) % count;
      points.push({ x: flat[i * 2], y: flat[i * 2 + 1], kind: "corner" });
      points.push({
        x: (flat[i * 2] + flat[next * 2]) / 2,
        y: (flat[i * 2 + 1] + flat[next * 2 + 1]) / 2,
        kind: "midpoint",
      });
    }

    return place([...points, { x: centerX, y: centerY, kind: "center" }]);
  }

  const candidates: SnapCandidate[] = [
    { x, y, kind: "corner" },
    { x: right, y, kind: "corner" },
    { x: right, y: bottom, kind: "corner" },
    { x, y: bottom, kind: "corner" },
    { x: centerX, y, kind: "midpoint" },
    { x: right, y: centerY, kind: "midpoint" },
    { x: centerX, y: bottom, kind: "midpoint" },
    { x, y: centerY, kind: "midpoint" },
    { x: centerX, y: centerY, kind: "center" },
  ];

  // An ellipse has no corners to speak of; its quadrant points are the midpoints
  // already listed, so drop the bounding-box corners.
  return place(
    element.tool === "Circle"
      ? candidates.filter((candidate) => candidate.kind !== "corner")
      : candidates,
  );
};

/**
 * Move `pointer` onto the nearest significant point within `threshold`, in world
 * units. Corners win ties over edge midpoints and centres, because a corner is
 * usually what someone is aiming at.
 */
export const snapToPoint = (
  pointer: Point,
  elements: readonly Shape[],
  threshold: number,
  excludeIds: ReadonlySet<string> = new Set(),
): SnapResult => {
  if (threshold <= 0) {
    return { point: pointer, snappedTo: null };
  }

  const priority: Record<SnapKind, number> = {
    corner: 0,
    endpoint: 1,
    midpoint: 2,
    center: 3,
  };

  let best: SnapCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const element of elements) {
    if (excludeIds.has(element.id)) {
      continue;
    }

    // Cheap reject: anything whose on-screen extent is far away cannot help.
    const bounds = getRotatedBounds(element);
    if (
      pointer.x < bounds.x - threshold ||
      pointer.x > bounds.x + bounds.width + threshold ||
      pointer.y < bounds.y - threshold ||
      pointer.y > bounds.y + bounds.height + threshold
    ) {
      continue;
    }

    for (const candidate of getElementSnapPoints(element)) {
      const distance = Math.hypot(
        candidate.x - pointer.x,
        candidate.y - pointer.y,
      );

      if (distance > threshold) {
        continue;
      }

      const closer = distance < bestDistance - 0.01;
      const tiedButBetterKind =
        Math.abs(distance - bestDistance) <= 0.01 &&
        best !== null &&
        priority[candidate.kind] < priority[best.kind];

      if (best === null || closer || tiedButBetterKind) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }

  return best
    ? { point: { x: best.x, y: best.y }, snappedTo: best }
    : { point: pointer, snappedTo: null };
};
