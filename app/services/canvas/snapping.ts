/**
 * Alignment guides and snapping.
 *
 * Pure functions over the scene: given what is moving and what is static,
 * return the snap offset to apply plus the guides to draw. The previous
 * implementation kept guides in React state and re-derived them mid-render,
 * which made snapping fight the drag.
 */
import type { AlignmentGuide, BoundingBox, Shape } from "../../types/shapes";
import { getElementBounds } from "./elements";

/** Snap distance in screen pixels. */
export const SNAP_THRESHOLD_PX = 6;

/** How far past the aligned edges a guide is drawn. */
const GUIDE_OVERSHOOT = 16;

interface Candidate {
  /** Coordinate on the snapping axis. */
  position: number;
  /** Extent on the other axis, used to size the guide. */
  from: number;
  to: number;
}

const collectCandidates = (
  elements: readonly Shape[],
  excludeIds: ReadonlySet<string>,
): { vertical: Candidate[]; horizontal: Candidate[] } => {
  const vertical: Candidate[] = [];
  const horizontal: Candidate[] = [];

  for (const element of elements) {
    if (element.isDeleted || excludeIds.has(element.id)) {
      continue;
    }

    const bounds = getElementBounds(element);

    for (const x of [
      bounds.x,
      bounds.x + bounds.width / 2,
      bounds.x + bounds.width,
    ]) {
      vertical.push({ position: x, from: bounds.y, to: bounds.y + bounds.height });
    }

    for (const y of [
      bounds.y,
      bounds.y + bounds.height / 2,
      bounds.y + bounds.height,
    ]) {
      horizontal.push({ position: y, from: bounds.x, to: bounds.x + bounds.width });
    }
  }

  return { vertical, horizontal };
};

export interface SnapResult {
  offset: { x: number; y: number };
  guides: AlignmentGuide[];
}

const NO_SNAP: SnapResult = { offset: { x: 0, y: 0 }, guides: [] };

/**
 * Find the smallest offset that aligns `bounds` with a nearby element edge or
 * centre, along with the guides that justify it.
 */
export const getSnapOffset = (
  bounds: BoundingBox,
  elements: readonly Shape[],
  excludeIds: ReadonlySet<string>,
  threshold: number,
): SnapResult => {
  if (threshold <= 0) {
    return NO_SNAP;
  }

  const { vertical, horizontal } = collectCandidates(elements, excludeIds);

  if (vertical.length === 0 && horizontal.length === 0) {
    return NO_SNAP;
  }

  const movingX = [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
  const movingY = [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];

  let bestX: { delta: number; candidate: Candidate } | null = null;
  let bestY: { delta: number; candidate: Candidate } | null = null;

  for (const candidate of vertical) {
    for (const value of movingX) {
      const delta = candidate.position - value;
      if (Math.abs(delta) <= threshold) {
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) {
          bestX = { delta, candidate };
        }
      }
    }
  }

  for (const candidate of horizontal) {
    for (const value of movingY) {
      const delta = candidate.position - value;
      if (Math.abs(delta) <= threshold) {
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) {
          bestY = { delta, candidate };
        }
      }
    }
  }

  const guides: AlignmentGuide[] = [];
  const offset = { x: bestX?.delta ?? 0, y: bestY?.delta ?? 0 };

  if (bestX) {
    const snapped = { ...bounds, x: bounds.x + offset.x, y: bounds.y + offset.y };
    guides.push({
      orientation: "vertical",
      position: bestX.candidate.position,
      from:
        Math.min(bestX.candidate.from, snapped.y) - GUIDE_OVERSHOOT,
      to:
        Math.max(bestX.candidate.to, snapped.y + snapped.height) + GUIDE_OVERSHOOT,
    });
  }

  if (bestY) {
    const snapped = { ...bounds, x: bounds.x + offset.x, y: bounds.y + offset.y };
    guides.push({
      orientation: "horizontal",
      position: bestY.candidate.position,
      from: Math.min(bestY.candidate.from, snapped.x) - GUIDE_OVERSHOOT,
      to:
        Math.max(bestY.candidate.to, snapped.x + snapped.width) + GUIDE_OVERSHOOT,
    });
  }

  return { offset, guides };
};
