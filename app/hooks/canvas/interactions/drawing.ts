import type { Point, Shape, ToolType } from "../../../types/shapes";
import { isLinearShape } from "../../../types/shapes";
import {
  getElementBounds,
  mutateElement,
  normalizeElement,
} from "../../../services/canvas/elements";
import {
  applyBindings,
  createBinding,
  getHoveredBindableElement,
} from "../../../services/canvas/bindings";
import { refreshLinearElement } from "../../../services/canvas/linearElement";
import { normalizeBox, simplifyPoints, snapAngle } from "../../../utils/geometry";
import { canBindToShapes, MIN_DRAW_SIZE_PX } from "./types";
import type { ElementsUpdater } from "../useScene";

export interface DrawingContext {
  elementsRef: React.MutableRefObject<Shape[]>;
  applyElements: (updater: ElementsUpdater, options?: { changedIds?: string[] }) => Shape[];
  worldThreshold: (pixels: number) => number;
  setPending: (element: Shape | null) => void;
  setSelectedIds: (ids: string[]) => void;
  setTool: (tool: ToolType) => void;
  toolLocked: boolean;
}

/**
 * Update the geometric bounds or linear endpoints while drawing.
 */
export function updateDrawnGeometry(
  element: Shape,
  origin: Point,
  pointer: Point,
  modifiers: { shiftKey: boolean; altKey: boolean },
  scene: Shape[],
): Shape {
  if (isLinearShape(element)) {
    const end = modifiers.shiftKey ? snapAngle(origin, pointer) : pointer;
    return refreshLinearElement(
      mutateElement(element, {
        x1: origin.x,
        y1: origin.y,
        x2: end.x,
        y2: end.y,
      }),
      scene,
    );
  }

  let box = normalizeBox(origin.x, origin.y, pointer.x, pointer.y);

  if (modifiers.shiftKey) {
    const size = Math.max(box.width, box.height);
    box = {
      x: pointer.x < origin.x ? origin.x - size : origin.x,
      y: pointer.y < origin.y ? origin.y - size : origin.y,
      width: size,
      height: size,
    };
  }

  if (modifiers.altKey) {
    box = {
      x: origin.x - box.width,
      y: origin.y - box.height,
      width: box.width * 2,
      height: box.height * 2,
    };
  }

  return mutateElement(element, box);
}

/**
 * While a line or arrow is being drawn, attach it provisionally to whatever
 * its ends are over and resolve the route.
 */
export function resolveDrawnLinear(
  element: Shape,
  startTargetId: string | null,
  origin: Point,
  pointer: Point,
  scene: Shape[],
  gap: number,
): { element: Shape; endTargetId: string | null } {
  if (!isLinearShape(element)) {
    return { element, endTargetId: null };
  }

  if (!canBindToShapes(element)) {
    return {
      element: refreshLinearElement(element, scene),
      endTargetId: null,
    };
  }

  const startTarget = startTargetId
    ? (scene.find((item) => item.id === startTargetId) ?? null)
    : null;
  const endTarget = getHoveredBindableElement(pointer, scene, gap, element.id);

  const provisional = mutateElement(element, {
    startBinding: startTarget ? createBinding(startTarget, origin, gap) : null,
    endBinding: endTarget ? createBinding(endTarget, pointer, gap) : null,
  });

  return {
    element: refreshLinearElement(provisional, scene),
    endTargetId: endTarget?.id ?? null,
  };
}

/**
 * Commit a completed drawn shape to the scene.
 */
export function finishDrawing(
  element: Shape,
  origin: Point,
  pointer: Point,
  ctx: DrawingContext,
): void {
  const minSize = ctx.worldThreshold(MIN_DRAW_SIZE_PX);
  const bounds = getElementBounds(element);

  const tooSmall =
    element.tool === "Freehand"
      ? element.points.length < 4
      : bounds.width < minSize && bounds.height < minSize;

  if (tooSmall) {
    ctx.setPending(null);
    return;
  }

  let finalElement = element;
  if (finalElement.tool === "Freehand") {
    finalElement = normalizeElement(
      mutateElement(finalElement, {
        points: simplifyPoints(finalElement.points, ctx.worldThreshold(0.7)),
      }),
    );
  }

  const committed = finalElement;
  ctx.setPending(null);

  ctx.applyElements(
    (previous) => {
      let next = [...previous, committed];
      if (isLinearShape(committed) && canBindToShapes(committed)) {
        next = applyBindings(next, committed.id, {
          start: committed.startBinding ?? null,
          end: committed.endBinding ?? null,
        });
      }
      return next;
    },
    { changedIds: [committed.id] },
  );

  ctx.setSelectedIds([committed.id]);
  if (!ctx.toolLocked) {
    ctx.setTool("Select");
  }
}
