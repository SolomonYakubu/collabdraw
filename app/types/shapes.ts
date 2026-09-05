/**
 * Scene element model.
 *
 * Wire format note: element `tool` names and the `fill` / `points` / `x1..y2`
 * fields are part of the collaboration payload and of the AI endpoint contract
 * (`app/api/generate-drawing/route.ts`), so they are kept stable. Everything
 * added here is optional or has a safe default so older payloads still load.
 */

/** Element kinds that can actually exist in the scene. */
export type ElementType =
  | "Freehand"
  | "Line"
  | "Arrow"
  | "Square"
  | "Circle"
  | "Diamond"
  | "Triangle"
  | "Text";

/** Everything selectable in the toolbar, including the non-drawing tools. */
export type ToolType = ElementType | "Select" | "Pan" | "Eraser";

/** Kept as an alias: a lot of props/pages still speak in terms of `ShapeType`. */
export type ShapeType = ToolType;

export const ELEMENT_TYPES: ElementType[] = [
  "Freehand",
  "Line",
  "Arrow",
  "Square",
  "Circle",
  "Diamond",
  "Triangle",
  "Text",
];

/** Shapes whose geometry is a box: x/y/width/height. */
export const BOX_ELEMENTS = new Set<ElementType>([
  "Square",
  "Circle",
  "Diamond",
  "Triangle",
  "Text",
]);

/** Shapes whose geometry is two endpoints. */
export const LINEAR_ELEMENTS = new Set<ElementType>(["Line", "Arrow"]);

export const isBoxElement = (tool: ElementType): boolean =>
  BOX_ELEMENTS.has(tool);

export const isLinearElement = (tool: ElementType): boolean =>
  LINEAR_ELEMENTS.has(tool);

export type FillStyle =
  | "solid"
  | "hachure"
  | "zigzag"
  | "cross-hatch"
  | "dots"
  | "dashed"
  | "zigzag-line";

export type StrokeStyle = "solid" | "dashed" | "dotted";

/**
 * How a line or arrow gets from one end to the other.
 *
 *  - `straight` — direct segments through any waypoints.
 *  - `curved`   — a smooth curve through the same points.
 *  - `elbow`    — orthogonal segments with rounded corners, routed around the
 *                 shapes the arrow is bound to.
 */
export type EdgeStyle = "straight" | "curved" | "elbow";

/** The side of a shape an arrow leaves from, for orthogonal routing. */
export type Heading = "up" | "right" | "down" | "left";

export const HEADING_VECTORS: Record<Heading, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/** Named roughness levels, mirroring Excalidraw's sloppiness control. */
export const ROUGHNESS = {
  architect: 0,
  artist: 1,
  cartoonist: 2,
} as const;

/**
 * A bound arrow endpoint.
 *
 * `focus` is the anchor inside the bound element, normalised to [-0.5, 0.5] on
 * each axis, so it survives moves and resizes. `gap` is how far the rendered
 * endpoint stops short of the element outline.
 */
export interface PointBinding {
  elementId: string;
  focus: { x: number; y: number };
  gap: number;
}

/** Back-reference from a shape to the arrows/labels attached to it. */
export interface BoundElement {
  id: string;
  type: "arrow" | "text";
}

export interface BaseShape {
  id: string;
  tool: ElementType;
  /** Top-left of the bounding box in world coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Rotation about the element's own centre, clockwise, in radians. The rotation
   * grip writes it through `normalizeAngle`, so it is always in `[0, 2π)`.
   */
  angle: number;
  stroke: string;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  /** Background colour. Named `fill` for wire compatibility. */
  fill: string;
  fillStyle: FillStyle;
  roughness: number;
  /** 0..100, matching the toolbar slider. */
  opacity: number;
  /** Stable rough.js seed. Without this every redraw re-randomises the sketch. */
  seed: number;
  /** Bumped on every mutation; used to invalidate the render cache. */
  version: number;
  /** Present on every element so generic code can read it without narrowing. */
  points: number[];
  /** Arrows and labels attached to this element. */
  boundElements?: BoundElement[] | null;
  userId?: string;
  /** Set while another user is still drawing this element. */
  isInProgress?: boolean;
  isDeleted?: boolean;
}

export interface FreehandShape extends BaseShape {
  tool: "Freehand";
  /** Flat absolute coordinates: [x0, y0, x1, y1, ...]. */
  points: number[];
}

export interface LinearShape extends BaseShape {
  tool: "Line" | "Arrow";
  /** The two ends, in world coordinates. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /**
   * Waypoints the user placed between the two ends, as a flat absolute list.
   * Only meaningful for `straight` and `curved`; an elbow's shape is decided by
   * the router.
   */
  midPoints: number[];
  edgeStyle: EdgeStyle;
  /**
   * The polyline actually drawn and hit-tested: the ends, the waypoints and,
   * for an elbow, the computed route around any bound shapes.
   *
   * Derived, never hand-edited — `refreshLinearElement` recomputes it whenever
   * the ends, waypoints, bindings or bound shapes change. It is stored rather
   * than computed on demand so that bounds, culling and hit testing stay pure
   * functions of a single element.
   */
  route: number[];
  startBinding?: PointBinding | null;
  endBinding?: PointBinding | null;
  startArrowhead?: boolean;
  endArrowhead?: boolean;
}

export interface LineShape extends LinearShape {
  tool: "Line";
}

export interface ArrowShape extends LinearShape {
  tool: "Arrow";
}

export interface SquareShape extends BaseShape {
  tool: "Square";
}

export interface CircleShape extends BaseShape {
  tool: "Circle";
}

export interface DiamondShape extends BaseShape {
  tool: "Diamond";
}

export interface TriangleShape extends BaseShape {
  tool: "Triangle";
}

export interface TextShape extends BaseShape {
  tool: "Text";
  text: string;
  fontSize: number;
  fontFamily: string;
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle";
  /** Set when this text is a label living inside a container shape. */
  containerId?: string | null;
}

export type Shape =
  | FreehandShape
  | LineShape
  | ArrowShape
  | SquareShape
  | CircleShape
  | DiamondShape
  | TriangleShape
  | TextShape;

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Viewport state. `scroll` is in world units, like Excalidraw's scrollX/scrollY. */
export interface Viewport {
  zoom: number;
  scroll: Point;
}

/** Line height multiplier used for text layout and measurement. */
export const LINE_HEIGHT = 1.25;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 30;

/**
 * The eight box resize handles, the two linear-element endpoints, an existing
 * waypoint (`mid-<index>`) and the phantom handle that inserts one on a segment
 * (`add-<index>`).
 */
export type TransformHandle =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "start"
  | "end"
  | "rotate"
  | `mid-${number}`
  | `add-${number}`;

export interface AlignmentGuide {
  position: number;
  orientation: "horizontal" | "vertical";
  /** World-space extent of the guide, so it is drawn only where it is relevant. */
  from: number;
  to: number;
}

/** Style properties shared between the toolbar defaults and each element. */
export interface ElementStyle {
  stroke: string;
  fill: string;
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roughness: number;
  opacity: number;
  fontSize: number;
  fontFamily: string;
  edgeStyle: EdgeStyle;
}

export const DEFAULT_STYLE: ElementStyle = {
  stroke: "#1e1e1e",
  fill: "transparent",
  fillStyle: "hachure",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: ROUGHNESS.artist,
  opacity: 100,
  fontSize: 20,
  fontFamily: "Virgil, Segoe UI Emoji, Comic Sans MS, cursive, sans-serif",
  edgeStyle: "curved",
};

export type TextShapeLike = TextShape;

export const isTextShape = (shape: Shape): shape is TextShape =>
  shape.tool === "Text";

export const isFreehandShape = (shape: Shape): shape is FreehandShape =>
  shape.tool === "Freehand";

export const isLinearShape = (shape: Shape): shape is LinearShape =>
  shape.tool === "Line" || shape.tool === "Arrow";

export const isBindableShape = (shape: Shape): boolean =>
  shape.tool === "Square" ||
  shape.tool === "Circle" ||
  shape.tool === "Diamond" ||
  shape.tool === "Triangle" ||
  shape.tool === "Text";

/** Containers that can hold a centred text label. */
export const isTextContainer = (shape: Shape): boolean =>
  shape.tool === "Square" ||
  shape.tool === "Circle" ||
  shape.tool === "Diamond" ||
  shape.tool === "Triangle";
