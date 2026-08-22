/**
 * Element construction, mutation and normalisation.
 *
 * Two invariants live here and nowhere else:
 *  - every element has a stable `seed`, so rough.js renders identical geometry
 *    on every frame instead of re-randomising the sketch on each redraw;
 *  - every mutation bumps `version`, which is what the render cache keys on.
 */
import { nanoid } from "nanoid";
import {
  BOX_ELEMENTS,
  DEFAULT_STYLE,
  ELEMENT_TYPES,
  LINEAR_ELEMENTS,
  LINE_HEIGHT,
  isLinearShape,
  type BaseShape,
  type BoundingBox,
  type ElementStyle,
  type ElementType,
  type LinearShape,
  type Point,
  type Shape,
  type TextShape,
} from "../../types/shapes";
import {
  boxCenter,
  normalizeBox,
  rotatePoint,
  rotatedBoxAABB,
} from "../../utils/geometry";
import { measureTextElement } from "./textMeasure";

export const generateShapeId = (): string => nanoid(12);

export const newSeed = (): number => Math.floor(Math.random() * 2 ** 31);

/**
 * Attributes accepted when building an element: every field of every element
 * kind, all optional. `Partial<Shape>` would not do, because a partial of a
 * union only admits the fields common to every member.
 */
export type ElementInit = Partial<BaseShape> &
  Partial<Omit<LinearShape, "tool">> &
  Partial<Omit<TextShape, "tool">> & {
    /** Aliases produced by older payloads and by the AI endpoint. */
    strokeColor?: string;
    backgroundColor?: string;
  };

const toFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const toStyle = (
  attrs: ElementInit,
  fallbackStroke: string,
  style: Partial<ElementStyle> = {},
): Pick<
  Shape,
  | "stroke"
  | "strokeWidth"
  | "strokeStyle"
  | "fill"
  | "fillStyle"
  | "roughness"
  | "opacity"
> => {
  const stroke =
    attrs.stroke ?? attrs.strokeColor ?? style.stroke ?? fallbackStroke;

  return {
    stroke: stroke || DEFAULT_STYLE.stroke,
    strokeWidth: toFiniteNumber(
      attrs.strokeWidth ?? style.strokeWidth,
      DEFAULT_STYLE.strokeWidth,
    ),
    strokeStyle: attrs.strokeStyle ?? style.strokeStyle ?? DEFAULT_STYLE.strokeStyle,
    fill: attrs.fill ?? attrs.backgroundColor ?? style.fill ?? DEFAULT_STYLE.fill,
    fillStyle: attrs.fillStyle ?? style.fillStyle ?? DEFAULT_STYLE.fillStyle,
    roughness: toFiniteNumber(
      attrs.roughness ?? style.roughness,
      DEFAULT_STYLE.roughness,
    ),
    opacity: toFiniteNumber(attrs.opacity ?? style.opacity, DEFAULT_STYLE.opacity),
  };
};

/**
 * Build a fully-formed element. Missing geometry is derived where possible so
 * that partial payloads (AI output, remote peers, older saves) still load.
 */
export const createElement = (
  tool: ElementType,
  attrs: ElementInit = {},
  fallbackStroke: string = DEFAULT_STYLE.stroke,
  style: Partial<ElementStyle> = {},
): Shape | null => {
  if (!BOX_ELEMENTS.has(tool) && !LINEAR_ELEMENTS.has(tool) && tool !== "Freehand") {
    return null;
  }

  const base = {
    id: typeof attrs.id === "string" && attrs.id ? attrs.id : generateShapeId(),
    tool,
    angle: toFiniteNumber(attrs.angle, 0),
    seed: toFiniteNumber(attrs.seed, newSeed()),
    version: toFiniteNumber(attrs.version, 1),
    points: Array.isArray(attrs.points) ? [...attrs.points] : [],
    boundElements: attrs.boundElements ?? null,
    userId: attrs.userId,
    isInProgress: attrs.isInProgress ?? false,
    isDeleted: attrs.isDeleted ?? false,
    ...toStyle(attrs, fallbackStroke, style),
  };

  if (LINEAR_ELEMENTS.has(tool)) {
    const x1 = toFiniteNumber(attrs.x1, toFiniteNumber(attrs.x, 0));
    const y1 = toFiniteNumber(attrs.y1, toFiniteNumber(attrs.y, 0));
    const x2 = toFiniteNumber(attrs.x2, x1);
    const y2 = toFiniteNumber(attrs.y2, y1);

    const midPoints = Array.isArray(attrs.midPoints) ? [...attrs.midPoints] : [];
    const route =
      Array.isArray(attrs.route) && attrs.route.length >= 4
        ? [...attrs.route]
        : [x1, y1, ...midPoints, x2, y2];

    return {
      ...base,
      tool: tool as "Line" | "Arrow",
      ...boundsOfFlatPoints(route),
      x1,
      y1,
      x2,
      y2,
      midPoints,
      route,
      edgeStyle: attrs.edgeStyle ?? style.edgeStyle ?? DEFAULT_STYLE.edgeStyle,
      startBinding: attrs.startBinding ?? null,
      endBinding: attrs.endBinding ?? null,
      startArrowhead: attrs.startArrowhead ?? false,
      endArrowhead: attrs.endArrowhead ?? tool === "Arrow",
      // A background on a line is never visible, and it would make the shape
      // hit-test as filled, so clicks would land on it from a distance.
      fill: "transparent",
    } as LinearShape;
  }

  if (tool === "Freehand") {
    const points = base.points.length >= 2
      ? base.points
      : [toFiniteNumber(attrs.x, 0), toFiniteNumber(attrs.y, 0)];
    const box = getPointsBounds(points);

    return {
      ...base,
      tool: "Freehand",
      points,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      // A stroke is drawn as a filled outline in its stroke colour; a separate
      // background would have no meaning.
      fill: "transparent",
    } as Shape;
  }

  if (tool === "Text") {
    const fontSize = toFiniteNumber(
      attrs.fontSize ?? style.fontSize,
      DEFAULT_STYLE.fontSize,
    );

    const text = typeof attrs.text === "string" ? attrs.text : "";
    const fontFamily =
      attrs.fontFamily ?? style.fontFamily ?? DEFAULT_STYLE.fontFamily;

    /*
     * Size the element to its content when no explicit box is given. Leaving
     * width at 0 produced text whose bounding box did not match what was drawn,
     * which broke hit testing, selection bounds and anything else reading those
     * bounds — a label placed programmatically appeared unselectable.
     */
    const needsMeasure =
      text !== "" &&
      (attrs.width === undefined || attrs.height === undefined) &&
      !attrs.containerId;
    const measured = needsMeasure
      ? measureTextElement({ text, fontSize, fontFamily })
      : null;

    return {
      ...base,
      tool: "Text",
      x: toFiniteNumber(attrs.x, 0),
      y: toFiniteNumber(attrs.y, 0),
      width: toFiniteNumber(attrs.width, measured?.width ?? 0),
      height: toFiniteNumber(
        attrs.height,
        measured?.height ?? fontSize * LINE_HEIGHT,
      ),
      text,
      fontSize,
      fontFamily,
      textAlign: attrs.textAlign ?? "left",
      verticalAlign: attrs.verticalAlign ?? "top",
      containerId: attrs.containerId ?? null,
      // Text uses its stroke colour as the glyph colour; a fill would look odd.
      fill: "transparent",
    } as TextShape;
  }

  // Square / Circle / Diamond
  const box = normalizeBox(
    toFiniteNumber(attrs.x, 0),
    toFiniteNumber(attrs.y, 0),
    toFiniteNumber(attrs.x, 0) + toFiniteNumber(attrs.width, 0),
    toFiniteNumber(attrs.y, 0) + toFiniteNumber(attrs.height, 0),
  );

  return {
    ...base,
    tool,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  } as Shape;
};

/**
 * Backwards-compatible alias. Older call sites (and the AI response handler)
 * pass `(tool, attrs, color)`.
 */
export const createShape = createElement;

/** Immutably update an element, bumping its render version. */
export const mutateElement = <T extends Shape>(
  element: T,
  updates: Partial<T>,
): T => ({
  ...element,
  ...updates,
  version: element.version + 1,
});

/** Offset a flat coordinate list. */
export { LINE_HEIGHT };

export const shiftFlatPoints = (
  flat: readonly number[],
  dx: number,
  dy: number,
): number[] => flat.map((value, index) => (index % 2 === 0 ? value + dx : value + dy));

/** Bounding box of a flat coordinate list. */
export const boundsOfFlatPoints = (flat: readonly number[]): BoundingBox =>
  getPointsBounds(flat);

export const getPointsBounds = (points: readonly number[]): BoundingBox => {
  if (points.length < 2) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let i = 0; i + 1 < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/** The element's axis-aligned bounding box in world coordinates. */
export const getElementBounds = (element: Shape): BoundingBox => {
  if (element.tool === "Freehand") {
    return getPointsBounds(element.points);
  }

  if (isLinearShape(element)) {
    return element.route.length >= 4
      ? boundsOfFlatPoints(element.route)
      : normalizeBox(element.x1, element.y1, element.x2, element.y2);
  }

  return {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  };
};

/** Kept for existing imports; identical to `getElementBounds`. */
export const getShapeBoundingBox = getElementBounds;

/**
 * The point an element rotates about: the centre of its own unrotated geometry.
 */
export const getElementCenter = (element: Shape): Point =>
  boxCenter(getElementBounds(element));

/**
 * Map a world point into the element's own frame — the frame its stored
 * geometry lives in, where the angle is zero.
 *
 * This is the whole trick that keeps rotation from spreading through the
 * codebase: hit testing, snapping and binding all convert the point first and
 * then reuse the existing unrotated maths untouched.
 */
export const toElementLocal = (point: Point, element: Shape): Point =>
  element.angle === 0
    ? point
    : rotatePoint(point, getElementCenter(element), -element.angle);

/** The inverse: a point in the element's frame, placed in the world. */
export const fromElementLocal = (point: Point, element: Shape): Point =>
  element.angle === 0
    ? point
    : rotatePoint(point, getElementCenter(element), element.angle);

/**
 * The axis-aligned box the element actually occupies on screen, rotation
 * included. Distinct from `getElementBounds`, which is its unrotated geometry.
 */
export const getRotatedBounds = (element: Shape): BoundingBox =>
  rotatedBoxAABB(getElementBounds(element), element.angle);

/**
 * Re-derive `x/y/width/height` from an element's authoritative geometry, so the
 * bounding box always agrees with what is drawn.
 */
export const normalizeElement = <T extends Shape>(element: T): T => {
  const bounds = getElementBounds(element);

  if (
    element.x === bounds.x &&
    element.y === bounds.y &&
    element.width === bounds.width &&
    element.height === bounds.height
  ) {
    return element;
  }

  return { ...element, ...bounds };
};

/** Translate an element by a world-space delta. */
export const translateElement = <T extends Shape>(
  element: T,
  dx: number,
  dy: number,
): T => {
  if (dx === 0 && dy === 0) {
    return element;
  }

  if (element.tool === "Freehand") {
    const points = element.points.map((value, index) =>
      index % 2 === 0 ? value + dx : value + dy,
    );
    return mutateElement(element, {
      points,
      x: element.x + dx,
      y: element.y + dy,
    } as unknown as Partial<T>);
  }

  if (isLinearShape(element)) {
    return mutateElement(element, {
      x: element.x + dx,
      y: element.y + dy,
      x1: element.x1 + dx,
      y1: element.y1 + dy,
      x2: element.x2 + dx,
      y2: element.y2 + dy,
      midPoints: shiftFlatPoints(element.midPoints, dx, dy),
      route: shiftFlatPoints(element.route, dx, dy),
    } as unknown as Partial<T>);
  }

  return mutateElement(element, {
    x: element.x + dx,
    y: element.y + dy,
  } as unknown as Partial<T>);
};

/** Fit an element into a new bounding box, scaling its inner geometry. */
export const resizeElementToBox = <T extends Shape>(
  element: T,
  next: BoundingBox,
): T => {
  const current = getElementBounds(element);
  const width = Math.max(next.width, 1);
  const height = Math.max(next.height, 1);

  if (element.tool === "Freehand") {
    const scaleX = current.width === 0 ? 1 : width / current.width;
    const scaleY = current.height === 0 ? 1 : height / current.height;
    const points = element.points.map((value, index) =>
      index % 2 === 0
        ? next.x + (value - current.x) * scaleX
        : next.y + (value - current.y) * scaleY,
    );

    return mutateElement(element, {
      points,
      x: next.x,
      y: next.y,
      width,
      height,
    } as unknown as Partial<T>);
  }

  if (isLinearShape(element)) {
    const scaleX = current.width === 0 ? 1 : width / current.width;
    const scaleY = current.height === 0 ? 1 : height / current.height;

    const scale = (flat: readonly number[]): number[] =>
      flat.map((value, index) =>
        index % 2 === 0
          ? next.x + (value - current.x) * scaleX
          : next.y + (value - current.y) * scaleY,
      );

    return mutateElement(element, {
      x: next.x,
      y: next.y,
      width,
      height,
      x1: next.x + (element.x1 - current.x) * scaleX,
      y1: next.y + (element.y1 - current.y) * scaleY,
      x2: next.x + (element.x2 - current.x) * scaleX,
      y2: next.y + (element.y2 - current.y) * scaleY,
      midPoints: scale(element.midPoints),
      route: scale(element.route),
    } as unknown as Partial<T>);
  }

  if (element.tool === "Text") {
    // Scaling a text box scales the font with it, like Excalidraw does.
    const scale = current.height === 0 ? 1 : height / current.height;
    return mutateElement(element, {
      x: next.x,
      y: next.y,
      width,
      height,
      fontSize: Math.max(8, (element as TextShape).fontSize * scale),
    } as unknown as Partial<T>);
  }

  return mutateElement(element, {
    x: next.x,
    y: next.y,
    width,
    height,
  } as unknown as Partial<T>);
};

/** Deep-ish clone with a fresh id and seed, offset by a delta. */
export const duplicateElement = <T extends Shape>(
  element: T,
  offset = 10,
): T => {
  const clone = {
    ...element,
    id: generateShapeId(),
    seed: newSeed(),
    version: 1,
    // Bindings and back-references are not valid for a copy.
    boundElements: null,
  } as T;

  if (isLinearShape(clone)) {
    (clone as unknown as LinearShape).startBinding = null;
    (clone as unknown as LinearShape).endBinding = null;
  }

  return translateElement(clone, offset, offset);
};

/**
 * Accept an arbitrary object (remote peer, localStorage, AI output) and return
 * a valid element, or null. This is the only place untrusted shapes enter.
 */
export const restoreElement = (input: unknown): Shape | null => {
  if (!input || typeof input !== "object") {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const tool = raw.tool;

  if (typeof tool !== "string") {
    return null;
  }

  // Older payloads used a few different spellings for the same shapes; anything
  // not listed here falls back to the element type of the same name.
  const aliases: Record<string, ElementType> = {
    Rect: "Square",
    Rectangle: "Square",
    Ellipse: "Circle",
    Draw: "Freehand",
  };

  const resolved =
    aliases[tool] ??
    (ELEMENT_TYPES.includes(tool as ElementType)
      ? (tool as ElementType)
      : undefined);
  if (!resolved) {
    return null;
  }

  return createElement(resolved, raw as ElementInit, DEFAULT_STYLE.stroke);
};

export const restoreElements = (input: unknown): Shape[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map(restoreElement)
    .filter((element): element is Shape => element !== null);
};
