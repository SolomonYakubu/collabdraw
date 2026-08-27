import type {
  AlignmentGuide,
  BoundingBox,
  Point,
  Shape,
  TransformHandle,
} from "../../../types/shapes";
import { isLinearShape } from "../../../types/shapes";
import {
  getElementCenter,
  mutateElement,
  translateElement,
} from "../../../services/canvas/elements";
import {
  applyBindings,
  createBinding,
  getHoveredBindableElement,
  MAX_BINDING_GAP_PX,
  updateBoundElements,
} from "../../../services/canvas/bindings";
import {
  applyResizeToElements,
  applyRotatedResize,
  getResizedBounds,
  getSelectionBounds,
  setElementAngle,
} from "../../../services/canvas/transform";
import {
  getSnapOffset,
  SNAP_THRESHOLD_PX,
} from "../../../services/canvas/snapping";
import { refreshLinearElement } from "../../../services/canvas/linearElement";
import {
  boxCenter,
  normalizeAngle,
  rotatePoint,
  snapAngle,
  snapAngleValue,
} from "../../../utils/geometry";
import { canBindToShapes, type InteractionVisuals } from "./types";
import type { ApplyOptions, ElementsUpdater } from "../useScene";

export interface TransformContext {
  elementsRef: React.MutableRefObject<Shape[]>;
  applyElements: (
    updater: ElementsUpdater,
    options?: ApplyOptions,
  ) => Shape[];
  patchVisuals: (patch: Partial<InteractionVisuals>) => void;
  worldThreshold: (pixels: number) => number;
  applyPointSnap: (
    pointer: Point,
    options?: { exclude?: string; disabled?: boolean },
  ) => Point;
}

export function applyDragTransform(
  snapshot: readonly Shape[],
  delta: Point,
  snap: boolean,
  ctx: TransformContext,
): void {
  const ids = new Set(snapshot.map((element) => element.id));
  const bounds = getSelectionBounds(snapshot);

  let offset = delta;
  let guides: AlignmentGuide[] = [];

  if (snap && bounds) {
    const moved = {
      ...bounds,
      x: bounds.x + delta.x,
      y: bounds.y + delta.y,
    };
    const result = getSnapOffset(
      moved,
      ctx.elementsRef.current,
      ids,
      ctx.worldThreshold(SNAP_THRESHOLD_PX),
    );
    offset = {
      x: delta.x + result.offset.x,
      y: delta.y + result.offset.y,
    };
    guides = result.guides;
  }

  ctx.patchVisuals({ guides, isTransforming: true });

  const originals = new Map(snapshot.map((element) => [element.id, element]));

  ctx.applyElements(
    (previous) => {
      const moved = previous.map((element) => {
        const original = originals.get(element.id);
        return original
          ? translateElement(original, offset.x, offset.y)
          : element;
      });

      return updateBoundElements(moved, ids, { skipSelf: true });
    },
    { commit: false, changedIds: [...ids] },
  );
}

export function applyResizeTransform(
  snapshot: readonly Shape[],
  initialBounds: BoundingBox,
  handle: TransformHandle,
  pointer: Point,
  modifiers: { shiftKey: boolean; altKey: boolean },
  ctx: TransformContext,
): void {
  const single = snapshot.length === 1 ? snapshot[0] : null;
  const angle = single?.angle ?? 0;

  const localPointer =
    angle === 0
      ? pointer
      : rotatePoint(pointer, boxCenter(initialBounds), -angle);

  const nextBounds = getResizedBounds(handle, initialBounds, localPointer, {
    preserveAspectRatio: modifiers.shiftKey,
    fromCenter: modifiers.altKey,
  });

  const ids = new Set(snapshot.map((element) => element.id));
  const resized =
    single && angle !== 0
      ? [applyRotatedResize(single, initialBounds, nextBounds)]
      : applyResizeToElements(snapshot, initialBounds, nextBounds);

  ctx.patchVisuals({ isTransforming: true, activeHandle: handle });

  ctx.applyElements(
    (previous) => {
      const byId = new Map(resized.map((element) => [element.id, element]));
      const next = previous.map((element) => byId.get(element.id) ?? element);
      return updateBoundElements(next, ids, { skipSelf: true });
    },
    { commit: false, changedIds: [...ids] },
  );
}

export function applyRotationTransform(
  snapshot: readonly Shape[],
  pivot: Point,
  grabOffset: number,
  pointer: Point,
  shiftKey: boolean,
  ctx: TransformContext,
): void {
  const raw =
    Math.atan2(pointer.y - pivot.y, pointer.x - pivot.x) - grabOffset;
  const angle = normalizeAngle(shiftKey ? snapAngleValue(raw) : raw);

  const ids = new Set(snapshot.map((element) => element.id));
  ctx.patchVisuals({ isTransforming: true, activeHandle: "rotate" });

  ctx.applyElements(
    (previous) => {
      const next = previous.map((element) => {
        const original = snapshot.find((item) => item.id === element.id);
        if (!original) return element;

        const rotatedCenter = rotatePoint(
          getElementCenter(original),
          pivot,
          angle,
        );
        const currentCenter = getElementCenter(original);

        const moved = translateElement(
          original,
          rotatedCenter.x - currentCenter.x,
          rotatedCenter.y - currentCenter.y,
        );

        return setElementAngle(moved, normalizeAngle(original.angle + angle));
      });

      return updateBoundElements(next, ids, { skipSelf: true });
    },
    { commit: false, changedIds: [...ids] },
  );
}

export function applyEndpointDragTransform(
  arrowId: string,
  which: "start" | "end",
  pointer: Point,
  shiftKey: boolean,
  ctx: TransformContext,
): void {
  const gap = ctx.worldThreshold(MAX_BINDING_GAP_PX);
  const snapped = ctx.applyPointSnap(pointer, {
    exclude: arrowId,
    disabled: shiftKey,
  });

  const arrow = ctx.elementsRef.current.find(
    (element) => element.id === arrowId,
  );
  const binds = Boolean(arrow && canBindToShapes(arrow));

  const hovered = binds
    ? getHoveredBindableElement(snapped, ctx.elementsRef.current, gap, arrowId)
    : null;

  ctx.patchVisuals({
    bindingHighlightId: hovered?.id ?? null,
    isTransforming: true,
  });

  ctx.applyElements(
    (previous) =>
      previous.map((element) => {
        if (element.id !== arrowId || !isLinearShape(element)) {
          return element;
        }

        const anchor =
          which === "start"
            ? { x: element.x2, y: element.y2 }
            : { x: element.x1, y: element.y1 };
        const target = shiftKey ? snapAngle(anchor, snapped) : snapped;

        const rebound = mutateElement(element, {
          ...(which === "start"
            ? { x1: target.x, y1: target.y }
            : { x2: target.x, y2: target.y }),
          ...(which === "start"
            ? {
                startBinding: hovered
                  ? createBinding(hovered, target, gap)
                  : null,
              }
            : {
                endBinding: hovered
                  ? createBinding(hovered, target, gap)
                  : null,
              }),
        });

        return refreshLinearElement(rebound, previous);
      }),
    { commit: false, changedIds: [arrowId] },
  );
}
