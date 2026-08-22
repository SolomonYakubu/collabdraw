/**
 * Arrow/line bindings — "connections".
 *
 * This module owns the binding *records*: which element an end is attached to,
 * where on it, and the reverse references that let a shape find its arrows.
 * The geometry that follows from a binding — where the end actually lands and
 * what path joins the two ends — lives in `linearElement.ts`.
 */
import {
  isBindableShape,
  isLinearShape,
  type BoundElement,
  type LinearShape,
  type Point,
  type PointBinding,
  type Shape,
} from "../../types/shapes";
import { clamp } from "../../utils/geometry";
import { getElementBounds, mutateElement } from "./elements";
import { distanceToElementOutline, hitTestElement } from "./hitTest";
import { MIN_BINDING_GAP, refreshLinearElement } from "./linearElement";

/** How far outside a shape the pointer can be and still bind, in screen px. */
export const MAX_BINDING_GAP_PX = 24;

/** Focus is clamped inside the shape so the aim point never sits on a corner. */
const MAX_FOCUS = 0.4;

export { MIN_BINDING_GAP };

/**
 * The bindable element a pointer is over, if any.
 * `gap` is in world units.
 */
export const getHoveredBindableElement = (
  point: Point,
  elements: readonly Shape[],
  gap: number,
  excludeId?: string,
): Shape | null => {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const element = elements[i];

    if (
      element.isDeleted ||
      element.id === excludeId ||
      !isBindableShape(element) ||
      // A label inside a shape binds through its container, not on its own.
      (element.tool === "Text" && element.containerId)
    ) {
      continue;
    }

    if (
      hitTestElement(point, element, gap) ||
      distanceToElementOutline(point, element) <= gap
    ) {
      return element;
    }
  }

  return null;
};

/**
 * Build a binding for a pointer position over `element`.
 *
 * `focus` records roughly where the user aimed, normalised to the shape's size,
 * so the arrow keeps pointing at the same part of it after a move or a resize.
 */
export const createBinding = (
  element: Shape,
  pointer: Point,
  maxGap: number,
): PointBinding => {
  const bounds = getElementBounds(element);
  const width = bounds.width || 1;
  const height = bounds.height || 1;

  const focus = {
    x: clamp((pointer.x - (bounds.x + width / 2)) / width, -MAX_FOCUS, MAX_FOCUS),
    y: clamp((pointer.y - (bounds.y + height / 2)) / height, -MAX_FOCUS, MAX_FOCUS),
  };

  const outlineDistance = distanceToElementOutline(pointer, element);
  const inside = hitTestElement(pointer, element, 0);
  const gap = inside
    ? MIN_BINDING_GAP
    : clamp(outlineDistance, MIN_BINDING_GAP, maxGap);

  return { elementId: element.id, focus, gap };
};

const withBoundElement = (element: Shape, bound: BoundElement): Shape => {
  const existing = element.boundElements ?? [];

  if (existing.some((entry) => entry.id === bound.id && entry.type === bound.type)) {
    return element;
  }

  return mutateElement(element, { boundElements: [...existing, bound] });
};

const withoutBoundElement = (element: Shape, id: string): Shape => {
  const existing = element.boundElements;

  if (!existing || existing.length === 0) {
    return element;
  }

  const next = existing.filter((entry) => entry.id !== id);
  return next.length === existing.length
    ? element
    : mutateElement(element, { boundElements: next.length > 0 ? next : null });
};

/**
 * Apply new start/end bindings to an arrow, keep every affected shape's
 * `boundElements` back-reference in sync, and re-resolve the arrow. Returns the
 * whole scene.
 */
export const applyBindings = (
  elements: readonly Shape[],
  arrowId: string,
  next: { start?: PointBinding | null; end?: PointBinding | null },
): Shape[] => {
  const arrow = elements.find((element) => element.id === arrowId);

  if (!arrow || !isLinearShape(arrow)) {
    return [...elements];
  }

  const previousIds = new Set(
    [arrow.startBinding?.elementId, arrow.endBinding?.elementId].filter(
      (id): id is string => Boolean(id),
    ),
  );

  const startBinding =
    next.start !== undefined ? next.start : arrow.startBinding ?? null;
  const endBinding = next.end !== undefined ? next.end : arrow.endBinding ?? null;

  const nextIds = new Set(
    [startBinding?.elementId, endBinding?.elementId].filter(
      (id): id is string => Boolean(id),
    ),
  );

  let result = elements.map((element) => {
    if (element.id === arrowId) {
      return mutateElement(arrow, { startBinding, endBinding });
    }

    if (previousIds.has(element.id) && !nextIds.has(element.id)) {
      return withoutBoundElement(element, arrowId);
    }

    if (nextIds.has(element.id)) {
      return withBoundElement(element, { id: arrowId, type: "arrow" });
    }

    return element;
  });

  // Snap the arrow onto its new bindings straight away.
  result = result.map((element) =>
    element.id === arrowId && isLinearShape(element)
      ? refreshLinearElement(element, result)
      : element,
  );

  return result;
};

/**
 * After moving or resizing elements, pull every arrow bound to them back into
 * place. `changedIds` limits the work to what actually moved.
 *
 * `skipSelf` excludes arrows that are themselves in `changedIds`. That is what
 * a drag needs: without it, dragging a bound arrow re-solved its own bindings
 * on every frame and snapped it straight back, so a bound arrow could never be
 * moved at all. On release, `settleBindingsAfterMove` decides whether the ends
 * left their shapes.
 */
export const updateBoundElements = (
  elements: readonly Shape[],
  changedIds: ReadonlySet<string>,
  { skipSelf = false }: { skipSelf?: boolean } = {},
): Shape[] => {
  if (changedIds.size === 0) {
    return [...elements];
  }

  const arrowIds = new Set<string>();

  for (const element of elements) {
    if (!changedIds.has(element.id)) {
      continue;
    }

    for (const bound of element.boundElements ?? []) {
      if (bound.type === "arrow" && !(skipSelf && changedIds.has(bound.id))) {
        arrowIds.add(bound.id);
      }
    }
  }

  // An arrow whose own geometry changed also needs re-solving, unless it is the
  // thing being dragged.
  if (!skipSelf) {
    for (const element of elements) {
      if (changedIds.has(element.id) && isLinearShape(element)) {
        arrowIds.add(element.id);
      }
    }
  }

  if (arrowIds.size === 0) {
    return [...elements];
  }

  return elements.map((element) =>
    arrowIds.has(element.id) && isLinearShape(element)
      ? refreshLinearElement(element, elements)
      : element,
  );
};

/**
 * Drop bindings that point at elements which no longer exist, and clear the
 * matching back-references. Call this after any deletion.
 */
export const removeStaleBindings = (elements: readonly Shape[]): Shape[] => {
  const liveIds = new Set(
    elements.filter((element) => !element.isDeleted).map((element) => element.id),
  );

  const cleaned = elements.map((element) => {
    let next = element;

    if (isLinearShape(next)) {
      const startValid =
        !next.startBinding || liveIds.has(next.startBinding.elementId);
      const endValid = !next.endBinding || liveIds.has(next.endBinding.elementId);

      if (!startValid || !endValid) {
        next = mutateElement(next, {
          startBinding: startValid ? next.startBinding : null,
          endBinding: endValid ? next.endBinding : null,
        });
      }
    }

    const bound = next.boundElements;
    if (bound && bound.length > 0) {
      const filtered = bound.filter((entry) => liveIds.has(entry.id));
      if (filtered.length !== bound.length) {
        next = mutateElement(next, {
          boundElements: filtered.length > 0 ? filtered : null,
        });
      }
    }

    return next;
  });

  // An arrow that just lost a binding keeps the end where it was, but its route
  // has to be rebuilt without the shape it used to hug.
  const released = new Set<string>();
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] !== elements[i] && isLinearShape(cleaned[i])) {
      released.add(cleaned[i].id);
    }
  }

  if (released.size === 0) {
    return cleaned;
  }

  return cleaned.map((element) =>
    released.has(element.id) && isLinearShape(element)
      ? refreshLinearElement(element, cleaned)
      : element,
  );
};

/**
 * When an arrow is dragged as a whole and its ends land back on the same shapes,
 * the bindings are kept; the ends that left their shape are released.
 */
export const releaseBindingsOutsideElements = (
  elements: readonly Shape[],
  arrowId: string,
  maxGap: number,
): Shape[] => {
  const arrow = elements.find((element) => element.id === arrowId);

  if (!arrow || !isLinearShape(arrow)) {
    return [...elements];
  }

  const stillBound = (
    binding: PointBinding | null | undefined,
    point: Point,
  ): boolean => {
    if (!binding) {
      return false;
    }
    const target = elements.find(
      (element) => element.id === binding.elementId && !element.isDeleted,
    );
    if (!target) {
      return false;
    }
    return (
      hitTestElement(point, target, maxGap) ||
      distanceToElementOutline(point, target) <= maxGap
    );
  };

  const keepStart = stillBound(arrow.startBinding, { x: arrow.x1, y: arrow.y1 });
  const keepEnd = stillBound(arrow.endBinding, { x: arrow.x2, y: arrow.y2 });

  if (keepStart && keepEnd) {
    return [...elements];
  }

  return applyBindings(elements, arrowId, {
    start: keepStart ? undefined : null,
    end: keepEnd ? undefined : null,
  });
};

/**
 * Finish a move or resize: release the bindings whose endpoints have left their
 * shapes, then snap whatever is still bound back into place.
 */
export const settleBindingsAfterMove = (
  elements: readonly Shape[],
  movedIds: ReadonlySet<string>,
  maxGap: number,
): Shape[] => {
  let next: readonly Shape[] = elements;

  for (const id of movedIds) {
    const element = next.find((item) => item.id === id);
    if (element && isLinearShape(element)) {
      next = releaseBindingsOutsideElements(next, id, maxGap);
    }
  }

  return updateBoundElements(next, movedIds);
};

/** Re-resolve a single arrow, e.g. after its edge style changed. */
export const refreshArrow = (
  elements: readonly Shape[],
  arrowId: string,
): Shape[] =>
  elements.map((element) =>
    element.id === arrowId && isLinearShape(element)
      ? refreshLinearElement(element as LinearShape, elements)
      : element,
  );
