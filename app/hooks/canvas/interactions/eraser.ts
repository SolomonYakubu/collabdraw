import type { Point, Shape } from "../../../types/shapes";
import { hitTestElementWithSegment } from "../../../services/canvas/hitTest";
import { ERASER_RADIUS_PX, type InteractionVisuals } from "./types";
import type { ElementsUpdater } from "../useScene";

export interface EraserContext {
  elementsRef: React.MutableRefObject<Shape[]>;
  erasingRef: React.MutableRefObject<Set<string>>;
  trailRef: React.MutableRefObject<Point[]>;
  selectedIdsRef: React.RefObject<string[]>;
  patchVisuals: (patch: Partial<InteractionVisuals>) => void;
  resetVisuals: () => void;
  applyElements: (
    updater: ElementsUpdater,
    options?: { deletedIds?: string[]; broadcast?: "none" | "elements" | "full" },
  ) => Shape[];
  setSelectedIds: (ids: string[]) => void;
  worldThreshold: (pixels: number) => number;
}

export function accumulateEraserHits(
  from: Point,
  to: Point,
  restore: boolean,
  ctx: EraserContext,
): void {
  const radius = ctx.worldThreshold(ERASER_RADIUS_PX);
  const set = ctx.erasingRef.current;
  let changed = false;

  for (const element of ctx.elementsRef.current) {
    if (!hitTestElementWithSegment(from, to, element, radius)) {
      continue;
    }

    if (restore) {
      changed = set.delete(element.id) || changed;
    } else if (!set.has(element.id)) {
      set.add(element.id);
      changed = true;
    }
  }

  const trail = ctx.trailRef.current;
  trail.push(to);
  if (trail.length > 64) {
    trail.shift();
  }

  if (changed) {
    ctx.patchVisuals({ erasingIds: new Set(set), eraserTrail: [...trail] });
  } else {
    ctx.patchVisuals({ eraserTrail: [...trail] });
  }
}

export function commitEraserDeletions(ctx: EraserContext): void {
  const ids = ctx.erasingRef.current;
  if (ids.size === 0) {
    ctx.resetVisuals();
    return;
  }

  const deleted = [...ids];
  ctx.resetVisuals();

  ctx.applyElements(
    (previous) => previous.filter((element) => !ids.has(element.id)),
    { deletedIds: deleted, broadcast: "elements" },
  );

  ctx.setSelectedIds(ctx.selectedIdsRef.current.filter((id) => !ids.has(id)));
}
