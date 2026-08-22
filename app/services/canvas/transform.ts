/**
 * Selection transforms: resizing one or many elements from a handle.
 *
 * The pointer state machine keeps an immutable snapshot of the selection when a
 * transform begins and re-derives the result from that snapshot on every move,
 * so a drag never compounds rounding error the way incremental deltas did.
 */
import type {
  BoundingBox,
  Point,
  Shape,
  TransformHandle,
} from "../../types/shapes";
import { boxCenter, rotateVector } from "../../utils/geometry";
import {
  getElementBounds,
  getRotatedBounds,
  mutateElement,
  resizeElementToBox,
  translateElement,
} from "./elements";

/** Nothing is allowed to collapse to zero, or scaling stops being invertible. */
const MIN_SIZE = 1;

const isWestHandle = (handle: TransformHandle): boolean =>
  handle === "nw" || handle === "w" || handle === "sw";

const isEastHandle = (handle: TransformHandle): boolean =>
  handle === "ne" || handle === "e" || handle === "se";

const isNorthHandle = (handle: TransformHandle): boolean =>
  handle === "nw" || handle === "n" || handle === "ne";

const isSouthHandle = (handle: TransformHandle): boolean =>
  handle === "sw" || handle === "s" || handle === "se";

export interface ResizeOptions {
  /** Shift: keep the selection's aspect ratio. */
  preserveAspectRatio?: boolean;
  /** Alt: resize about the selection centre. */
  fromCenter?: boolean;
}

/** The bounding box a resize handle produces for a given pointer position. */
export const getResizedBounds = (
  handle: TransformHandle,
  initial: BoundingBox,
  pointer: { x: number; y: number },
  options: ResizeOptions = {},
): BoundingBox => {
  const right = initial.x + initial.width;
  const bottom = initial.y + initial.height;
  const centerX = initial.x + initial.width / 2;
  const centerY = initial.y + initial.height / 2;

  let x = initial.x;
  let y = initial.y;
  let width = initial.width;
  let height = initial.height;

  if (options.fromCenter) {
    if (isWestHandle(handle) || isEastHandle(handle)) {
      const halfWidth = Math.max(MIN_SIZE / 2, Math.abs(pointer.x - centerX));
      x = centerX - halfWidth;
      width = halfWidth * 2;
    }
    if (isNorthHandle(handle) || isSouthHandle(handle)) {
      const halfHeight = Math.max(MIN_SIZE / 2, Math.abs(pointer.y - centerY));
      y = centerY - halfHeight;
      height = halfHeight * 2;
    }
  } else {
    if (isWestHandle(handle)) {
      x = Math.min(pointer.x, right - MIN_SIZE);
      width = right - x;
    } else if (isEastHandle(handle)) {
      width = Math.max(MIN_SIZE, pointer.x - initial.x);
    }

    if (isNorthHandle(handle)) {
      y = Math.min(pointer.y, bottom - MIN_SIZE);
      height = bottom - y;
    } else if (isSouthHandle(handle)) {
      height = Math.max(MIN_SIZE, pointer.y - initial.y);
    }
  }

  if (
    options.preserveAspectRatio &&
    initial.width > 0 &&
    initial.height > 0 &&
    // Side handles only move one axis, so there is no ratio to preserve.
    handle.length === 2
  ) {
    const ratio = initial.width / initial.height;
    const byWidth = Math.abs(width / ratio - height) < Math.abs(height * ratio - width);

    if (byWidth) {
      height = Math.max(MIN_SIZE, width / ratio);
    } else {
      width = Math.max(MIN_SIZE, height * ratio);
    }

    if (options.fromCenter) {
      x = centerX - width / 2;
      y = centerY - height / 2;
    } else {
      if (isWestHandle(handle)) {
        x = right - width;
      }
      if (isNorthHandle(handle)) {
        y = bottom - height;
      }
    }
  }

  return { x, y, width: Math.max(MIN_SIZE, width), height: Math.max(MIN_SIZE, height) };
};

/**
 * Map a resize of the selection box onto every element inside it, preserving
 * each element's relative position and proportions.
 */
export const applyResizeToElements = (
  snapshot: readonly Shape[],
  initial: BoundingBox,
  next: BoundingBox,
): Shape[] => {
  if (initial.width === 0 || initial.height === 0) {
    return [...snapshot];
  }

  const scaleX = next.width / initial.width;
  const scaleY = next.height / initial.height;

  return snapshot.map((element) => {
    const bounds = getElementBounds(element);

    return resizeElementToBox(element, {
      x: next.x + (bounds.x - initial.x) * scaleX,
      y: next.y + (bounds.y - initial.y) * scaleY,
      width: Math.max(MIN_SIZE, bounds.width * scaleX),
      height: Math.max(MIN_SIZE, bounds.height * scaleY),
    });
  });
};

/**
 * Combined bounding box of a set of elements.
 *
 * A single element reports its *own* box, so the selection frame can be drawn
 * turned with it. Several elements have no shared angle, so their on-screen
 * extents are combined into an upright box.
 */
export const getSelectionBounds = (
  elements: readonly Shape[],
): BoundingBox | null => {
  if (elements.length === 0) {
    return null;
  }

  if (elements.length === 1) {
    return getElementBounds(elements[0]);
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    const bounds = getRotatedBounds(element);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/**
 * Resize a single rotated element.
 *
 * The element turns about the centre of its own box, so changing the box moves
 * that centre — and the corner the user is *not* dragging would drift away from
 * where they left it. Translating by `(R(θ) − I)·Δcentre` cancels exactly that
 * drift, whichever handle is in use.
 */
export const applyRotatedResize = (
  element: Shape,
  initial: BoundingBox,
  next: BoundingBox,
): Shape => {
  const resized = resizeElementToBox(element, next);

  if (element.angle === 0) {
    return resized;
  }

  const shift = {
    x: boxCenter(next).x - boxCenter(initial).x,
    y: boxCenter(next).y - boxCenter(initial).y,
  };

  const rotated = rotateVector(shift, element.angle);
  const correction: Point = {
    x: rotated.x - shift.x,
    y: rotated.y - shift.y,
  };

  return translateElement(resized, correction.x, correction.y);
};

/** Set an element's angle, rotating about its own centre. */
export const setElementAngle = <T extends Shape>(
  element: T,
  angle: number,
): T => mutateElement(element, { angle } as Partial<T>);
