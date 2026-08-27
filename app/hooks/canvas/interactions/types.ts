import type {
  AlignmentGuide,
  BoundingBox,
  Point,
  Shape,
  ToolType,
  TransformHandle,
} from "../../../types/shapes";
import { ELEMENT_TYPES } from "../../../types/shapes";
import type { SnapCandidate } from "../../../services/canvas/pointSnapping";

/** Pointer travel before a click turns into a drag, in screen pixels. */
export const DRAG_THRESHOLD_PX = 2;

/** Smaller than this and a drawn shape is treated as a stray click. */
export const MIN_DRAW_SIZE_PX = 4;

/** Minimum spacing between recorded freehand points, in screen pixels. */
export const FREEHAND_MIN_SPACING_PX = 1.5;

/** Eraser radius in screen pixels. */
export const ERASER_RADIUS_PX = 12;

export type Interaction =
  | { type: "idle" }
  | { type: "panning"; lastClient: Point }
  | {
      type: "drawing";
      origin: Point;
      element: Shape;
      /** Shape the start of a line/arrow landed on, bound provisionally. */
      startTargetId: string | null;
    }
  | { type: "freedraw"; element: Shape; lastWorld: Point }
  | { type: "marquee"; origin: Point; baseSelection: string[] }
  | {
      type: "pendingDrag";
      origin: Point;
      elementId: string;
      snapshot: Shape[];
      altKey: boolean;
    }
  | { type: "dragging"; origin: Point; snapshot: Shape[] }
  | {
      type: "resizing";
      handle: TransformHandle;
      initialBounds: BoundingBox;
      snapshot: Shape[];
    }
  | {
      type: "endpoint";
      arrowId: string;
      which: "start" | "end";
      snapshot: Shape[];
    }
  | { type: "waypoint"; arrowId: string; index: number }
  | {
      type: "rotating";
      snapshot: Shape[];
      pivot: Point;
      /** Pointer angle at the start, so the shape does not jump on grab. */
      grabOffset: number;
    }
  | { type: "erasing"; lastWorld: Point }
  | {
      type: "pinch";
      lastMidpoint: Point;
      lastDistance: number;
    };

/** Everything the interactive layer needs to draw, mirrored into state. */
export interface InteractionVisuals {
  marquee: BoundingBox | null;
  guides: AlignmentGuide[];
  bindingHighlightId: string | null;
  eraserTrail: Point[];
  erasingIds: Set<string>;
  isTransforming: boolean;
  activeHandle: TransformHandle | null;
  /** The vertex an endpoint is currently locked onto, for feedback. */
  snapPoint: SnapCandidate | null;
}

export const EMPTY_VISUALS: InteractionVisuals = {
  marquee: null,
  guides: [],
  bindingHighlightId: null,
  eraserTrail: [],
  erasingIds: new Set(),
  isTransforming: false,
  activeHandle: null,
  snapPoint: null,
};

/**
 * Only arrows attach themselves to shapes.
 *
 * A plain line stays exactly where it is put, which is what makes it usable for
 * geometry — joining two corners to draw a cube, for instance. Binding a line
 * dragged its ends onto the nearest outline and stood them off by the binding
 * gap, so the corners could never actually meet. Excalidraw draws the same
 * distinction.
 */
export const canBindToShapes = (element: Shape): boolean =>
  element.tool === "Arrow";

/**
 * Tools that create an element by dragging.
 *
 * Derived from the element model rather than listed by hand: a hand-written list
 * silently omitted the triangle when it was added, so its tool selected but drew
 * nothing. Text is the one element with its own path — a click, not a drag.
 */
export const DRAWING_TOOLS = new Set<ToolType>(
  ELEMENT_TYPES.filter((type) => type !== "Text"),
);
