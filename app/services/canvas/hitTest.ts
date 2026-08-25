/**
 * Hit testing.
 *
 * Matches Excalidraw's rule, which the previous bounding-box test got wrong:
 * an element with a transparent background is only hit *near its stroke*, so
 * clicking through the middle of an empty rectangle selects whatever is behind
 * it rather than the rectangle. Filled elements are hit anywhere inside.
 */
import {
  isLinearShape,
  type BoundingBox,
  type Point,
  type Shape,
  type TransformHandle,
} from "../../types/shapes";
import {
  boxCenter,
  diamondPoints,
  distanceToBoxOutline,
  distanceToEllipseOutline,
  distanceToPolyline,
  distanceToSegment,
  isPointInBox,
  isPointInEllipse,
  isPointInPolygon,
  rotatePoint,
  trianglePoints,
} from "../../utils/geometry";
import { getElementBounds, getRotatedBounds, toElementLocal } from "./elements";
import {
  getControlPoints,
  getLinearPath,
  getSegmentMidpoints,
} from "./linearElement";

/** Click tolerance around a stroke, in screen pixels. */
export const HIT_THRESHOLD_PX = 10;

/** Size of a transform handle, in screen pixels. */
export const HANDLE_SIZE_PX = 8;

/** Below this size a shape gets handles outside its outline instead of on it. */
export const MIN_HANDLE_SPACING_PX = 24;

/** How far above the top edge the rotation handle sits, in screen pixels. */
export const ROTATE_HANDLE_OFFSET_PX = 22;

const hasBackground = (element: Shape): boolean =>
  element.fill !== "transparent" && element.fill !== "" && element.fill !== "none";

/**
 * Distance from a point to an element's outline, in world units.
 * Returns `Infinity` for elements with no meaningful outline.
 */
export const distanceToElementOutline = (
  worldPoint: Point,
  element: Shape,
): number => {
  // Everything below works in the element's own unrotated frame.
  const point = toElementLocal(worldPoint, element);
  const bounds = getElementBounds(element);

  switch (element.tool) {
    case "Freehand":
      return distanceToPolyline(point.x, point.y, element.points);

    case "Line":
    case "Arrow": {
      // Measured against the resolved route, so a bent or elbowed connector is
      // grabbable along its whole length rather than only end to end.
      const path = getLinearPath(element);
      const flat: number[] = [];
      for (const vertex of path) {
        flat.push(vertex.x, vertex.y);
      }
      return distanceToPolyline(point.x, point.y, flat);
    }

    case "Circle":
      return distanceToEllipseOutline(point.x, point.y, bounds);

    case "Diamond":
      return distanceToPolyline(point.x, point.y, diamondPoints(bounds), true);

    case "Triangle":
      return distanceToPolyline(point.x, point.y, trianglePoints(bounds), true);

    case "Square":
    case "Text":
      return distanceToBoxOutline(point.x, point.y, bounds);

    default:
      return Number.POSITIVE_INFINITY;
  }
};

const isPointInsideElement = (worldPoint: Point, element: Shape): boolean => {
  const point = toElementLocal(worldPoint, element);
  const bounds = getElementBounds(element);

  switch (element.tool) {
    case "Circle":
      return isPointInEllipse(point.x, point.y, bounds);
    case "Diamond":
      return isPointInPolygon(point.x, point.y, diamondPoints(bounds));
    case "Triangle":
      return isPointInPolygon(point.x, point.y, trianglePoints(bounds));
    case "Square":
    case "Text":
      return isPointInBox(point.x, point.y, bounds);
    default:
      return false;
  }
};

/**
 * Whether a world point hits an element.
 *
 * `threshold` is in world units; callers should pass
 * `HIT_THRESHOLD_PX / viewport.zoom` so the grab area stays constant on screen.
 *
 * `includeInterior` makes the whole bounded area grabbable, ignoring the
 * transparent-fill rule. Selection uses it so a shape can be picked up and
 * dragged from its middle; the eraser and click-through paths leave it off so
 * an empty shape still erases on its stroke and lets clicks fall through.
 */
export const hitTestElement = (
  point: Point,
  element: Shape,
  threshold: number,
  includeInterior = false,
): boolean => {
  if (element.isDeleted) {
    return false;
  }

  // Text is always treated as filled: you grab it anywhere on the glyph box.
  if (element.tool === "Text") {
    const local = toElementLocal(point, element);
    return isPointInBox(
      local.x,
      local.y,
      getElementBounds(element),
      threshold / 2,
    );
  }

  const strokeSlop = threshold + element.strokeWidth / 2;

  if (distanceToElementOutline(point, element) <= strokeSlop) {
    return true;
  }

  return (
    (includeInterior || hasBackground(element)) &&
    isPointInsideElement(point, element)
  );
};

/**
 * Topmost element under a point. Elements later in the array are on top, which
 * is why iteration runs backwards.
 */
export const getElementAtPoint = (
  point: Point,
  elements: readonly Shape[],
  threshold: number,
  includeInterior = false,
): Shape | null => {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    if (hitTestElement(point, elements[i], threshold, includeInterior)) {
      return elements[i];
    }
  }
  return null;
};

/** Every element under a point, topmost first. */
export const getElementsAtPoint = (
  point: Point,
  elements: readonly Shape[],
  threshold: number,
  includeInterior = false,
): Shape[] => {
  const hits: Shape[] = [];
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    if (hitTestElement(point, elements[i], threshold, includeInterior)) {
      hits.push(elements[i]);
    }
  }
  return hits;
};

/**
 * Elements selected by a marquee. Excalidraw selects anything the rectangle
 * touches, not only fully-enclosed elements.
 */
export const getElementsInBox = (
  box: BoundingBox,
  elements: readonly Shape[],
): Shape[] =>
  elements.filter((element) => {
    if (element.isDeleted) {
      return false;
    }

    // A marquee is a screen rectangle, so it tests against the rotated extent.
    const bounds = getRotatedBounds(element);
    return (
      bounds.x < box.x + box.width &&
      bounds.x + bounds.width > box.x &&
      bounds.y < box.y + box.height &&
      bounds.y + bounds.height > box.y
    );
  });

/**
 * Whether the segment travelled by the eraser between two samples touches an
 * element. Sampling only the current pointer position misses elements when the
 * pointer moves fast, which made the old eraser feel unreliable.
 */
export const hitTestElementWithSegment = (
  from: Point,
  to: Point,
  element: Shape,
  threshold: number,
): boolean => {
  if (element.isDeleted) {
    return false;
  }

  // Walk the segment in steps no larger than the threshold.
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(length / Math.max(threshold, 1)));

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const sample = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    };

    if (hitTestElement(sample, element, threshold)) {
      return true;
    }
  }

  return false;
};

export interface TransformHandleRect extends BoundingBox {
  name: TransformHandle;
  /**
   * Centre of the handle in world coordinates. For a rotated element the handle
   * is not axis-aligned, so its box alone does not locate it.
   */
  center: Point;
}

/**
 * The angle a selection's handles are drawn at.
 *
 * A single element's handles turn with it, which is what makes a rotated shape
 * feel like an object rather than a picture in a box. A mixed selection has no
 * single angle, so its handles stay upright.
 */
export const getSelectionAngle = (elements: readonly Shape[]): number =>
  elements.length === 1 ? elements[0].angle : 0;

/**
 * Transform handles for a selection, in world coordinates.
 *
 * A single linear element gets endpoint handles instead of the eight box
 * handles, plus one handle per waypoint and a phantom handle in the middle of
 * each segment. Dragging a phantom pulls a new bend out of the line.
 *
 * An elbow's shape belongs to the router, so it offers no waypoint handles.
 */
export const getTransformHandles = (
  elements: readonly Shape[],
  bounds: BoundingBox,
  zoom: number,
): TransformHandleRect[] => {
  const size = HANDLE_SIZE_PX / zoom;
  const half = size / 2;

  const angle = getSelectionAngle(elements);
  const pivot = boxCenter(bounds);

  /**
   * Handles are positioned in the selection's own frame and then rotated with
   * it, so grabbing the corner of a tilted shape works where you see it.
   */
  const square = (name: TransformHandle, at: Point): TransformHandleRect => {
    const center = angle === 0 ? at : rotatePoint(at, pivot, angle);
    return {
      name,
      center,
      x: center.x - half,
      y: center.y - half,
      width: size,
      height: size,
    };
  };

  const single = elements.length === 1 ? elements[0] : null;

  if (single && isLinearShape(single)) {
    const handles: TransformHandleRect[] = [
      square("start", { x: single.x1, y: single.y1 }),
      square("end", { x: single.x2, y: single.y2 }),
    ];

    if (single.edgeStyle === "elbow") {
      return handles;
    }

    const waypoints = getControlPoints(single).slice(1, -1);
    waypoints.forEach((point, index) => {
      handles.push(square(`mid-${index}`, point));
    });

    // Phantom handles only make sense where there is room to grab one.
    const minSegment = (HANDLE_SIZE_PX * 3) / zoom;
    const controls = getControlPoints(single);

    getSegmentMidpoints(single).forEach((point, index) => {
      const from = controls[index];
      const to = controls[index + 1];

      if (Math.hypot(to.x - from.x, to.y - from.y) >= minSegment) {
        handles.push(square(`add-${index}`, point));
      }
    });

    return handles;
  }

  // Very small selections get their side handles dropped so they stay usable.
  const spacing = MIN_HANDLE_SPACING_PX / zoom;
  const includeSides = bounds.width > spacing && bounds.height > spacing;

  const positions: Array<{ name: TransformHandle; x: number; y: number }> = [
    { name: "nw", x: bounds.x, y: bounds.y },
    { name: "ne", x: bounds.x + bounds.width, y: bounds.y },
    { name: "se", x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { name: "sw", x: bounds.x, y: bounds.y + bounds.height },
  ];

  if (includeSides) {
    positions.push(
      { name: "n", x: bounds.x + bounds.width / 2, y: bounds.y },
      { name: "e", x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 },
      { name: "s", x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
      { name: "w", x: bounds.x, y: bounds.y + bounds.height / 2 },
    );
  }

  const handles = positions.map(({ name, x, y }) => square(name, { x, y }));

  // Rotation grabs a handle standing off from the top edge.
  handles.push(
    square("rotate", {
      x: bounds.x + bounds.width / 2,
      y: bounds.y - ROTATE_HANDLE_OFFSET_PX / zoom,
    }),
  );

  return handles;
};

export const getTransformHandleAtPoint = (
  point: Point,
  elements: readonly Shape[],
  bounds: BoundingBox,
  zoom: number,
): TransformHandle | null => {
  // Handles are small, so give them a slightly generous grab area.
  const slop = 2 / zoom;

  const hits = getTransformHandles(elements, bounds, zoom).filter((handle) =>
    isPointInBox(point.x, point.y, handle, slop),
  );

  if (hits.length === 0) {
    return null;
  }

  // A phantom insert handle sits on the line between two real ones, so anything
  // concrete takes priority over it.
  const concrete = hits.find((handle) => !handle.name.startsWith("add-"));
  return (concrete ?? hits[0]).name;
};

/** Handle kinds, for callers that need to branch on them. */
export const isWaypointHandle = (
  handle: TransformHandle,
): handle is `mid-${number}` => handle.startsWith("mid-");

export const isInsertHandle = (
  handle: TransformHandle,
): handle is `add-${number}` => handle.startsWith("add-");

export const getHandleIndex = (handle: TransformHandle): number => {
  const index = Number(handle.slice(handle.indexOf("-") + 1));
  return Number.isFinite(index) ? index : -1;
};

/** CSS cursor for a transform handle. */
export const getHandleCursor = (handle: TransformHandle): string => {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "rotate":
      return "grab";
    case "start":
    case "end":
      return "move";
    default:
      // Waypoint and insert handles.
      return handle.startsWith("add-") ? "copy" : "move";
  }
};
