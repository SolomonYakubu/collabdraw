"use client";

/**
 * The single pointer state machine for the canvas.
 *
 * Replaces three overlapping implementations (`useCanvasEventHandlers`,
 * `useCanvasInteractions` and the handlers inlined in `RoughCanvas`) that each
 * did their own hit testing and their own screen->world maths, and disagreed
 * with one another at any zoom other than 1.
 *
 * Interaction state lives in a ref, so a fast pointer stream never reads a
 * stale closure; only the parts the interactive layer has to draw are mirrored
 * into React state.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ELEMENT_TYPES,
  isLinearShape,
  isTextContainer,
  type AlignmentGuide,
  type BoundingBox,
  type ElementStyle,
  type ElementType,
  type LinearShape,
  type Point,
  type Shape,
  type ToolType,
  type TransformHandle,
  type Viewport,
} from "../../types/shapes";
import {
  createElement,
  duplicateElement,
  getElementBounds,
  getElementCenter,
  mutateElement,
  normalizeElement,
  translateElement,
} from "../../services/canvas/elements";
import {
  getElementAtPoint,
  getElementsInBox,
  getHandleCursor,
  getHandleIndex,
  getTransformHandleAtPoint,
  hitTestElementWithSegment,
  isInsertHandle,
  isWaypointHandle,
  HIT_THRESHOLD_PX,
} from "../../services/canvas/hitTest";
import {
  getControlPoints,
  insertWaypoint,
  moveWaypoint,
  refreshLinearElement,
  removeWaypoint,
} from "../../services/canvas/linearElement";
import {
  applyBindings,
  createBinding,
  getHoveredBindableElement,
  MAX_BINDING_GAP_PX,
  settleBindingsAfterMove,
  updateBoundElements,
} from "../../services/canvas/bindings";
import {
  applyResizeToElements,
  applyRotatedResize,
  getResizedBounds,
  getSelectionBounds,
  setElementAngle,
} from "../../services/canvas/transform";
import {
  getSnapOffset,
  SNAP_THRESHOLD_PX,
} from "../../services/canvas/snapping";
import {
  snapToPoint,
  SNAP_POINT_THRESHOLD_PX,
  type SnapCandidate,
} from "../../services/canvas/pointSnapping";
import {
  boxCenter,
  distanceToSegment,
  normalizeBox,
  normalizeAngle,
  rotatePoint,
  simplifyPoints,
  snapAngle,
  snapAngleValue,
} from "../../utils/geometry";
import { clampZoom, clientToWorld, zoomAtPoint } from "../../utils/viewport";
import type { ApplyOptions, ElementsUpdater } from "./useScene";

/** Pointer travel before a click turns into a drag, in screen pixels. */
const DRAG_THRESHOLD_PX = 2;

/** Smaller than this and a drawn shape is treated as a stray click. */
const MIN_DRAW_SIZE_PX = 4;

/** Minimum spacing between recorded freehand points, in screen pixels. */
const FREEHAND_MIN_SPACING_PX = 1.5;

/** Eraser radius in screen pixels. */
const ERASER_RADIUS_PX = 12;

type Interaction =
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

const EMPTY_VISUALS: InteractionVisuals = {
  marquee: null,
  guides: [],
  bindingHighlightId: null,
  eraserTrail: [],
  erasingIds: new Set(),
  isTransforming: false,
  activeHandle: null,
  snapPoint: null,
};

export interface UsePointerInteractionProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  elementsRef: React.MutableRefObject<Shape[]>;
  applyElements: (updater: ElementsUpdater, options?: ApplyOptions) => Shape[];
  viewportRef: React.MutableRefObject<Viewport>;
  setViewport: React.Dispatch<React.SetStateAction<Viewport>>;
  tool: ToolType;
  setTool: (tool: ToolType) => void;
  toolLocked: boolean;
  style: ElementStyle;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  /** Held space turns any tool into a temporary pan tool, as in Excalidraw. */
  spacePressedRef: React.MutableRefObject<boolean>;
  onEditText: (elementId: string) => void;
  onCreateText: (point: Point, containerId?: string | null) => void;
  /** Called with the element being drawn so it can be shared with peers. */
  onPendingElementChange?: (element: Shape | null) => void;
}

export interface PointerInteraction {
  pendingElement: Shape | null;
  visuals: InteractionVisuals;
  cursor: string;
  handlers: {
    onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    onDoubleClick: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  };
  /** Abort whatever is in progress, e.g. when Escape is pressed. */
  cancel: () => void;
}

/**
 * Only arrows attach themselves to shapes.
 *
 * A plain line stays exactly where it is put, which is what makes it usable for
 * geometry — joining two corners to draw a cube, for instance. Binding a line
 * dragged its ends onto the nearest outline and stood them off by the binding
 * gap, so the corners could never actually meet. Excalidraw draws the same
 * distinction.
 */
const canBindToShapes = (element: Shape): boolean => element.tool === "Arrow";

/**
 * Tools that create an element by dragging.
 *
 * Derived from the element model rather than listed by hand: a hand-written list
 * silently omitted the triangle when it was added, so its tool selected but drew
 * nothing. Text is the one element with its own path — a click, not a drag.
 */
const DRAWING_TOOLS = new Set<ToolType>(
  ELEMENT_TYPES.filter((type) => type !== "Text"),
);

export const usePointerInteraction = ({
  canvasRef,
  elementsRef,
  applyElements,
  viewportRef,
  setViewport,
  tool,
  setTool,
  toolLocked,
  style,
  selectedIds,
  setSelectedIds,
  spacePressedRef,
  onEditText,
  onCreateText,
  onPendingElementChange,
}: UsePointerInteractionProps): PointerInteraction => {
  const interactionRef = useRef<Interaction>({ type: "idle" });
  const activePointersRef = useRef<Map<number, Point>>(new Map());
  const erasingRef = useRef<Set<string>>(new Set());
  const trailRef = useRef<Point[]>([]);

  const [pendingElement, setPendingElement] = useState<Shape | null>(null);
  const [visuals, setVisuals] = useState<InteractionVisuals>(EMPTY_VISUALS);
  const [hoverCursor, setHoverCursor] = useState<string>("default");

  // Selection is read inside pointer handlers, which must not go stale.
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const styleRef = useRef(style);
  styleRef.current = style;

  const toolRef = useRef(tool);
  toolRef.current = tool;

  const pendingRef = useRef<Shape | null>(null);
  const setPending = useCallback(
    (element: Shape | null) => {
      pendingRef.current = element;
      setPendingElement(element);
      onPendingElementChange?.(element);
    },
    [onPendingElementChange],
  );

  const patchVisuals = useCallback((patch: Partial<InteractionVisuals>) => {
    setVisuals((current) => ({ ...current, ...patch }));
  }, []);

  const resetVisuals = useCallback(() => {
    erasingRef.current = new Set();
    trailRef.current = [];
    setVisuals(EMPTY_VISUALS);
  }, []);

  const getWorldPoint = useCallback(
    (event: { clientX: number; clientY: number }): Point => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return { x: 0, y: 0 };
      }
      return clientToWorld(
        event.clientX,
        event.clientY,
        canvas.getBoundingClientRect(),
        viewportRef.current,
      );
    },
    [canvasRef, viewportRef],
  );

  const worldThreshold = useCallback(
    (pixels: number) => pixels / viewportRef.current.zoom,
    [viewportRef],
  );

  /**
   * Put a point on a nearby vertex, edge midpoint or centre.
   *
   * This is what makes corner-to-corner drawing possible: without it the end of
   * a line lands wherever the pointer happened to be, and two lines meeting at a
   * corner never quite touch. Holding shift means the user is constraining the
   * angle deliberately, so snapping stands aside.
   */
  const applyPointSnap = useCallback(
    (
      pointer: Point,
      { exclude, disabled }: { exclude?: string; disabled?: boolean } = {},
    ): Point => {
      if (disabled) {
        patchVisuals({ snapPoint: null });
        return pointer;
      }

      const result = snapToPoint(
        pointer,
        elementsRef.current,
        worldThreshold(SNAP_POINT_THRESHOLD_PX),
        exclude ? new Set([exclude]) : undefined,
      );

      patchVisuals({ snapPoint: result.snappedTo });
      return result.point;
    },
    [elementsRef, patchVisuals, worldThreshold],
  );

  const getSelectedElements = useCallback(
    (ids: readonly string[] = selectedIdsRef.current): Shape[] => {
      if (ids.length === 0) {
        return [];
      }
      const wanted = new Set(ids);
      return elementsRef.current.filter((element) => wanted.has(element.id));
    },
    [elementsRef],
  );

  /* ------------------------------------------------------------------ *
   * Drawing
   * ------------------------------------------------------------------ */

  const updateDrawnGeometry = useCallback(
    (
      element: Shape,
      origin: Point,
      pointer: Point,
      modifiers: { shiftKey: boolean; altKey: boolean },
    ): Shape => {
      if (isLinearShape(element)) {
        const end = modifiers.shiftKey ? snapAngle(origin, pointer) : pointer;

        // `route` is derived from the ends, and the renderer, the bounds and the
        // hit test all read it — so moving an end without re-resolving leaves an
        // element that draws as nothing.
        return refreshLinearElement(
          mutateElement(element, {
            x1: origin.x,
            y1: origin.y,
            x2: end.x,
            y2: end.y,
          }),
          elementsRef.current,
        );
      }

      let box = normalizeBox(origin.x, origin.y, pointer.x, pointer.y);

      if (modifiers.shiftKey) {
        // Square / circle: lock to the larger dimension, keeping the anchor.
        const size = Math.max(box.width, box.height);
        box = {
          x: pointer.x < origin.x ? origin.x - size : origin.x,
          y: pointer.y < origin.y ? origin.y - size : origin.y,
          width: size,
          height: size,
        };
      }

      if (modifiers.altKey) {
        // Alt draws outward from the origin instead of towards the pointer.
        box = {
          x: origin.x - box.width,
          y: origin.y - box.height,
          width: box.width * 2,
          height: box.height * 2,
        };
      }

      return mutateElement(element, box);
    },
    [elementsRef],
  );

  /**
   * While a line or arrow is being drawn, attach it provisionally to whatever
   * its ends are over and resolve the route. That is what makes the connector
   * snap to a shape's edge and, for an elbow, bend into place as you drag,
   * instead of only settling once the pointer is released.
   */
  const resolveDrawnLinear = useCallback(
    (
      element: Shape,
      startTargetId: string | null,
      origin: Point,
      pointer: Point,
    ): { element: Shape; endTargetId: string | null } => {
      if (!isLinearShape(element)) {
        return { element, endTargetId: null };
      }

      const scene = elementsRef.current;

      if (!canBindToShapes(element)) {
        // A plain line never attaches to anything, but its path still has to be
        // resolved from its ends and waypoints.
        return {
          element: refreshLinearElement(element, scene),
          endTargetId: null,
        };
      }
      const gap = worldThreshold(MAX_BINDING_GAP_PX);

      const startTarget = startTargetId
        ? (scene.find((item) => item.id === startTargetId) ?? null)
        : null;
      const endTarget = getHoveredBindableElement(
        pointer,
        scene,
        gap,
        element.id,
      );

      const provisional = mutateElement(element, {
        startBinding: startTarget
          ? createBinding(startTarget, origin, gap)
          : null,
        endBinding: endTarget ? createBinding(endTarget, pointer, gap) : null,
      });

      return {
        element: refreshLinearElement(provisional, scene),
        endTargetId: endTarget?.id ?? null,
      };
    },
    [elementsRef, worldThreshold],
  );

  const finishDrawing = useCallback(
    (element: Shape, origin: Point, pointer: Point) => {
      const minSize = worldThreshold(MIN_DRAW_SIZE_PX);
      const bounds = getElementBounds(element);

      const tooSmall =
        element.tool === "Freehand"
          ? element.points.length < 4
          : bounds.width < minSize && bounds.height < minSize;

      if (tooSmall) {
        setPending(null);
        return;
      }

      let finalElement = element;

      if (finalElement.tool === "Freehand") {
        finalElement = normalizeElement(
          mutateElement(finalElement, {
            points: simplifyPoints(finalElement.points, worldThreshold(0.7)),
          }),
        );
      }

      const committed = finalElement;
      setPending(null);

      applyElements(
        (previous) => {
          let next = [...previous, committed];

          // The element already carries the bindings worked out during the
          // drag; this records the reverse references and settles the route.
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

      // Excalidraw hands you back the selection tool with the new shape
      // selected, unless the tool lock is on.
      setSelectedIds([committed.id]);
      if (!toolLocked) {
        setTool("Select");
      }
    },
    [
      applyElements,
      setPending,
      setSelectedIds,
      setTool,
      toolLocked,
      worldThreshold,
    ],
  );

  /* ------------------------------------------------------------------ *
   * Eraser
   * ------------------------------------------------------------------ */

  const accumulateErasures = useCallback(
    (from: Point, to: Point, restore: boolean) => {
      const radius = worldThreshold(ERASER_RADIUS_PX);
      const set = erasingRef.current;
      let changed = false;

      for (const element of elementsRef.current) {
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

      const trail = trailRef.current;
      trail.push(to);
      if (trail.length > 64) {
        trail.shift();
      }

      if (changed) {
        patchVisuals({ erasingIds: new Set(set), eraserTrail: [...trail] });
      } else {
        patchVisuals({ eraserTrail: [...trail] });
      }
    },
    [elementsRef, patchVisuals, worldThreshold],
  );

  const commitErasures = useCallback(() => {
    const ids = erasingRef.current;

    if (ids.size === 0) {
      resetVisuals();
      return;
    }

    const deleted = [...ids];
    resetVisuals();

    applyElements(
      (previous) => previous.filter((element) => !ids.has(element.id)),
      { deletedIds: deleted, broadcast: "elements" },
    );

    setSelectedIds(selectedIdsRef.current.filter((id) => !ids.has(id)));
  }, [applyElements, resetVisuals, setSelectedIds]);

  /* ------------------------------------------------------------------ *
   * Dragging and resizing
   * ------------------------------------------------------------------ */

  const applyDrag = useCallback(
    (snapshot: readonly Shape[], delta: Point, snap: boolean) => {
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
          elementsRef.current,
          ids,
          worldThreshold(SNAP_THRESHOLD_PX),
        );
        offset = {
          x: delta.x + result.offset.x,
          y: delta.y + result.offset.y,
        };
        guides = result.guides;
      }

      patchVisuals({ guides, isTransforming: true });

      // Indexed once per frame: a linear scan per element would be quadratic
      // in the size of the selection.
      const originals = new Map(
        snapshot.map((element) => [element.id, element]),
      );

      applyElements(
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
    },
    [applyElements, elementsRef, patchVisuals, worldThreshold],
  );

  const applyResize = useCallback(
    (
      snapshot: readonly Shape[],
      initialBounds: BoundingBox,
      handle: TransformHandle,
      pointer: Point,
      modifiers: { shiftKey: boolean; altKey: boolean },
    ) => {
      const single = snapshot.length === 1 ? snapshot[0] : null;
      const angle = single?.angle ?? 0;

      // A rotated handle is dragged where it is seen, so the pointer has to come
      // back into the element's own frame before the box maths can use it.
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

      patchVisuals({ isTransforming: true, activeHandle: handle });

      applyElements(
        (previous) => {
          const byId = new Map(resized.map((element) => [element.id, element]));
          const next = previous.map(
            (element) => byId.get(element.id) ?? element,
          );
          return updateBoundElements(next, ids, { skipSelf: true });
        },
        { commit: false, changedIds: [...ids] },
      );
    },
    [applyElements, patchVisuals],
  );

  const applyEndpointDrag = useCallback(
    (
      arrowId: string,
      which: "start" | "end",
      pointer: Point,
      shiftKey: boolean,
    ) => {
      const gap = worldThreshold(MAX_BINDING_GAP_PX);
      const snapped = applyPointSnap(pointer, {
        exclude: arrowId,
        disabled: shiftKey,
      });

      const arrow = elementsRef.current.find(
        (element) => element.id === arrowId,
      );
      const binds = Boolean(arrow && canBindToShapes(arrow));

      const hovered = binds
        ? getHoveredBindableElement(snapped, elementsRef.current, gap, arrowId)
        : null;

      patchVisuals({
        bindingHighlightId: hovered?.id ?? null,
        isTransforming: true,
      });

      applyElements(
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

            // Provisionally rebind while dragging, so the end snaps to the
            // shape under the pointer and an elbow re-routes as you go.
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
    },
    [applyElements, applyPointSnap, elementsRef, patchVisuals, worldThreshold],
  );

  const applyRotation = useCallback(
    (
      snapshot: readonly Shape[],
      pivot: Point,
      grabOffset: number,
      pointer: Point,
      shiftKey: boolean,
    ) => {
      const raw =
        Math.atan2(pointer.y - pivot.y, pointer.x - pivot.x) - grabOffset;
      // Shift steps in 15° increments, matching the angle constraint elsewhere.
      const angle = normalizeAngle(shiftKey ? snapAngleValue(raw) : raw);

      const ids = new Set(snapshot.map((element) => element.id));
      patchVisuals({ isTransforming: true, activeHandle: "rotate" });

      applyElements(
        (previous) => {
          const next = previous.map((element) => {
            const original = snapshot.find((item) => item.id === element.id);

            if (!original) {
              return element;
            }

            // Several elements turn as a group: each keeps its own angle offset
            // and its centre orbits the shared pivot.
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

            return setElementAngle(
              moved,
              normalizeAngle(original.angle + angle),
            );
          });

          return updateBoundElements(next, ids, { skipSelf: true });
        },
        { commit: false, changedIds: [...ids] },
      );
    },
    [applyElements, patchVisuals],
  );

  /* ------------------------------------------------------------------ *
   * Pointer handlers
   * ------------------------------------------------------------------ */

  const beginPan = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      interactionRef.current = {
        type: "panning",
        lastClient: { x: event.clientX, y: event.clientY },
      };
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Right-click is the context menu's; let it through untouched.
      if (event.button === 2) {
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();

      activePointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      // If two or more fingers touch, enter pinch/pan mode and cancel any active drawing/dragging
      if (activePointersRef.current.size >= 2) {
        const current = interactionRef.current;
        if (current.type === "drawing" || current.type === "freedraw") {
          setPending(null);
        } else if (
          current.type === "dragging" ||
          current.type === "pendingDrag" ||
          current.type === "resizing" ||
          current.type === "rotating"
        ) {
          const snapshot = "snapshot" in current ? current.snapshot : [];
          if (snapshot.length > 0) {
            const byId = new Map(snapshot.map((el) => [el.id, el]));
            applyElements((prev) => prev.map((el) => byId.get(el.id) ?? el), {
              commit: false,
              broadcast: "elements",
            });
          }
        }
        resetVisuals();

        const pts = Array.from(activePointersRef.current.values());
        const p1 = pts[0];
        const p2 = pts[1];
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

        interactionRef.current = {
          type: "pinch",
          lastMidpoint: mid,
          lastDistance: dist,
        };
        return;
      }

      const activeTool = toolRef.current;
      const point = getWorldPoint(event);

      // Middle mouse, space and the hand tool all pan, from any tool.
      if (
        event.button === 1 ||
        spacePressedRef.current ||
        activeTool === "Pan"
      ) {
        beginPan(event);
        return;
      }

      if (event.button !== 0) {
        return;
      }

      if (activeTool === "Eraser") {
        erasingRef.current = new Set();
        trailRef.current = [point];
        interactionRef.current = { type: "erasing", lastWorld: point };
        accumulateErasures(point, point, event.altKey);
        return;
      }

      if (activeTool === "Text") {
        const hit = getElementAtPoint(
          point,
          elementsRef.current,
          worldThreshold(HIT_THRESHOLD_PX),
        );

        if (hit?.tool === "Text") {
          onEditText(hit.id);
        } else if (hit && isTextContainer(hit)) {
          onCreateText(point, hit.id);
        } else {
          onCreateText(point, null);
        }

        if (!toolLocked) {
          setTool("Select");
        }
        return;
      }

      if (DRAWING_TOOLS.has(activeTool)) {
        setSelectedIds([]);

        // A line or arrow begins on a vertex if there is one under the pointer.
        const start =
          activeTool === "Line" || activeTool === "Arrow"
            ? applyPointSnap(point, { disabled: event.shiftKey })
            : point;

        const element = createElement(
          activeTool as ElementType,
          activeTool === "Freehand"
            ? { x: start.x, y: start.y, points: [start.x, start.y] }
            : {
                x: start.x,
                y: start.y,
                x1: start.x,
                y1: start.y,
                x2: start.x,
                y2: start.y,
                width: 0,
                height: 0,
              },
          styleRef.current.stroke,
          styleRef.current,
        );

        if (!element) {
          return;
        }

        if (activeTool === "Freehand") {
          setPending(element);
          interactionRef.current = {
            type: "freedraw",
            element,
            lastWorld: point,
          };
          return;
        }

        const startTarget = canBindToShapes(element)
          ? getHoveredBindableElement(
              start,
              elementsRef.current,
              worldThreshold(MAX_BINDING_GAP_PX),
              element.id,
            )
          : null;

        setPending(element);
        interactionRef.current = {
          type: "drawing",
          origin: start,
          element,
          startTargetId: startTarget?.id ?? null,
        };
        return;
      }

      /* --- Selection tool --- */

      const threshold = worldThreshold(HIT_THRESHOLD_PX);
      const selected = getSelectedElements();
      const selectionBounds = getSelectionBounds(selected);

      if (selectionBounds) {
        const handle = getTransformHandleAtPoint(
          point,
          selected,
          selectionBounds,
          viewportRef.current.zoom,
        );

        if (handle === "rotate") {
          const pivot = boxCenter(selectionBounds);
          interactionRef.current = {
            type: "rotating",
            snapshot: selected.map((element) => ({ ...element })),
            pivot,
            // Measured from the grab point so the shape does not jump.
            grabOffset: Math.atan2(point.y - pivot.y, point.x - pivot.x),
          };
          return;
        }

        if (handle === "start" || handle === "end") {
          interactionRef.current = {
            type: "endpoint",
            arrowId: selected[0].id,
            which: handle,
            snapshot: selected.map((element) => ({ ...element })),
          };
          return;
        }

        if (handle && (isWaypointHandle(handle) || isInsertHandle(handle))) {
          const arrow = selected[0];
          const index = getHandleIndex(handle);

          if (isWaypointHandle(handle)) {
            // Alt-click removes a bend instead of moving it.
            if (event.altKey) {
              applyElements(
                (previous) =>
                  previous.map((element) =>
                    element.id === arrow.id && isLinearShape(element)
                      ? refreshLinearElement(
                          removeWaypoint(element, index),
                          previous,
                        )
                      : element,
                  ),
                { changedIds: [arrow.id] },
              );
              return;
            }

            interactionRef.current = {
              type: "waypoint",
              arrowId: arrow.id,
              index,
            };
            return;
          }

          // Pulling a phantom handle out of a segment creates a new bend there,
          // which then becomes the thing being dragged.
          applyElements(
            (previous) =>
              previous.map((element) =>
                element.id === arrow.id && isLinearShape(element)
                  ? refreshLinearElement(
                      insertWaypoint(element, index, point),
                      previous,
                    )
                  : element,
              ),
            { commit: false, changedIds: [arrow.id] },
          );

          interactionRef.current = {
            type: "waypoint",
            arrowId: arrow.id,
            index,
          };
          return;
        }

        if (handle) {
          interactionRef.current = {
            type: "resizing",
            handle,
            initialBounds: selectionBounds,
            snapshot: selected.map((element) => ({ ...element })),
          };
          return;
        }
      }

      const hit = getElementAtPoint(
        point,
        elementsRef.current,
        threshold,
        true,
      );

      if (!hit) {
        interactionRef.current = {
          type: "marquee",
          origin: point,
          baseSelection: event.shiftKey ? [...selectedIdsRef.current] : [],
        };

        if (!event.shiftKey) {
          setSelectedIds([]);
        }
        return;
      }

      let nextSelection: string[];

      if (event.shiftKey) {
        nextSelection = selectedIdsRef.current.includes(hit.id)
          ? selectedIdsRef.current.filter((id) => id !== hit.id)
          : [...selectedIdsRef.current, hit.id];
      } else if (selectedIdsRef.current.includes(hit.id)) {
        nextSelection = [...selectedIdsRef.current];
      } else {
        nextSelection = [hit.id];
      }

      setSelectedIds(nextSelection);

      interactionRef.current = {
        type: "pendingDrag",
        origin: point,
        elementId: hit.id,
        snapshot: getSelectedElements(nextSelection).map((element) => ({
          ...element,
        })),
        altKey: event.altKey,
      };
    },
    [
      accumulateErasures,
      beginPan,
      canvasRef,
      elementsRef,
      getSelectedElements,
      getWorldPoint,
      onCreateText,
      onEditText,
      setPending,
      setSelectedIds,
      setTool,
      spacePressedRef,
      toolLocked,
      viewportRef,
      worldThreshold,
    ],
  );

  const updateHoverCursor = useCallback(
    (point: Point) => {
      const activeTool = toolRef.current;

      if (spacePressedRef.current || activeTool === "Pan") {
        setHoverCursor("grab");
        return;
      }

      if (activeTool === "Eraser") {
        setHoverCursor("crosshair");
        return;
      }

      if (activeTool !== "Select") {
        setHoverCursor("crosshair");
        return;
      }

      const selected = getSelectedElements();
      const bounds = getSelectionBounds(selected);

      if (bounds) {
        const handle = getTransformHandleAtPoint(
          point,
          selected,
          bounds,
          viewportRef.current.zoom,
        );
        if (handle) {
          setHoverCursor(getHandleCursor(handle));
          return;
        }
      }

      const hit = getElementAtPoint(
        point,
        elementsRef.current,
        worldThreshold(HIT_THRESHOLD_PX),
        true,
      );

      setHoverCursor(hit ? "move" : "default");
    },
    [
      elementsRef,
      getSelectedElements,
      spacePressedRef,
      viewportRef,
      worldThreshold,
    ],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (activePointersRef.current.has(event.pointerId)) {
        activePointersRef.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
      }

      if (activePointersRef.current.size >= 2) {
        const pts = Array.from(activePointersRef.current.values());
        const p1 = pts[0];
        const p2 = pts[1];
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

        const canvas = canvasRef.current;
        const rect = canvas
          ? canvas.getBoundingClientRect()
          : { left: 0, top: 0 };

        if (interactionRef.current.type === "pinch") {
          const { lastDistance, lastMidpoint } = interactionRef.current;
          const ratio = dist / (lastDistance || 1);
          const dx = mid.x - lastMidpoint.x;
          const dy = mid.y - lastMidpoint.y;

          const anchor = {
            x: mid.x - rect.left,
            y: mid.y - rect.top,
          };

          setViewport((current) => {
            const nextZoom = clampZoom(current.zoom * ratio);
            const zoomed = zoomAtPoint(current, nextZoom, anchor);
            return {
              ...zoomed,
              scroll: {
                x: zoomed.scroll.x + dx / zoomed.zoom,
                y: zoomed.scroll.y + dy / zoomed.zoom,
              },
            };
          });
        }

        interactionRef.current = {
          type: "pinch",
          lastMidpoint: mid,
          lastDistance: dist,
        };
        return;
      }

      const interaction = interactionRef.current;
      const point = getWorldPoint(event);

      if (interaction.type === "idle") {
        updateHoverCursor(point);
        return;
      }

      switch (interaction.type) {
        case "panning": {
          const dx = event.clientX - interaction.lastClient.x;
          const dy = event.clientY - interaction.lastClient.y;
          interactionRef.current = {
            type: "panning",
            lastClient: { x: event.clientX, y: event.clientY },
          };
          setViewport((current) => ({
            ...current,
            scroll: {
              x: current.scroll.x + dx / current.zoom,
              y: current.scroll.y + dy / current.zoom,
            },
          }));
          return;
        }

        case "drawing": {
          const target = isLinearShape(interaction.element)
            ? applyPointSnap(point, {
                exclude: interaction.element.id,
                disabled: event.shiftKey,
              })
            : point;

          const geometry = updateDrawnGeometry(
            interaction.element,
            interaction.origin,
            target,
            { shiftKey: event.shiftKey, altKey: event.altKey },
          );

          const { element: next, endTargetId } = resolveDrawnLinear(
            geometry,
            interaction.startTargetId,
            interaction.origin,
            target,
          );

          interactionRef.current = { ...interaction, element: next };
          setPending(next);

          if (isLinearShape(next)) {
            patchVisuals({
              bindingHighlightId: endTargetId ?? interaction.startTargetId,
            });
          }
          return;
        }

        case "freedraw": {
          const spacing = worldThreshold(FREEHAND_MIN_SPACING_PX);
          const { lastWorld } = interaction;

          if (
            Math.hypot(point.x - lastWorld.x, point.y - lastWorld.y) < spacing
          ) {
            return;
          }

          const next = normalizeElement(
            mutateElement(interaction.element, {
              points: [...interaction.element.points, point.x, point.y],
            }),
          );

          interactionRef.current = {
            type: "freedraw",
            element: next,
            lastWorld: point,
          };
          setPending(next);
          return;
        }

        case "marquee": {
          const box = normalizeBox(
            interaction.origin.x,
            interaction.origin.y,
            point.x,
            point.y,
          );
          patchVisuals({ marquee: box });

          const inside = getElementsInBox(box, elementsRef.current).map(
            (element) => element.id,
          );
          const merged = new Set([...interaction.baseSelection, ...inside]);
          setSelectedIds([...merged]);
          return;
        }

        case "pendingDrag": {
          const travelled = Math.hypot(
            point.x - interaction.origin.x,
            point.y - interaction.origin.y,
          );

          if (travelled < worldThreshold(DRAG_THRESHOLD_PX)) {
            return;
          }

          let snapshot = interaction.snapshot;

          // Alt+drag leaves the originals behind and moves copies.
          if (interaction.altKey) {
            const copies = snapshot.map((element) =>
              duplicateElement(element, 0),
            );
            applyElements((previous) => [...previous, ...copies], {
              commit: false,
              changedIds: copies.map((element) => element.id),
            });
            setSelectedIds(copies.map((element) => element.id));
            snapshot = copies;
          }

          interactionRef.current = {
            type: "dragging",
            origin: interaction.origin,
            snapshot,
          };

          applyDrag(
            snapshot,
            {
              x: point.x - interaction.origin.x,
              y: point.y - interaction.origin.y,
            },
            !event.ctrlKey && !event.metaKey,
          );
          return;
        }

        case "dragging": {
          applyDrag(
            interaction.snapshot,
            {
              x: point.x - interaction.origin.x,
              y: point.y - interaction.origin.y,
            },
            !event.ctrlKey && !event.metaKey,
          );
          return;
        }

        case "rotating": {
          applyRotation(
            interaction.snapshot,
            interaction.pivot,
            interaction.grabOffset,
            point,
            event.shiftKey,
          );
          return;
        }

        case "resizing": {
          applyResize(
            interaction.snapshot,
            interaction.initialBounds,
            interaction.handle,
            point,
            { shiftKey: event.shiftKey, altKey: event.altKey },
          );
          return;
        }

        case "endpoint": {
          applyEndpointDrag(
            interaction.arrowId,
            interaction.which,
            point,
            event.shiftKey,
          );
          return;
        }

        case "waypoint": {
          const { arrowId, index } = interaction;
          patchVisuals({ isTransforming: true });

          const target = applyPointSnap(point, {
            exclude: arrowId,
            disabled: event.shiftKey,
          });

          applyElements(
            (previous) =>
              previous.map((element) =>
                element.id === arrowId && isLinearShape(element)
                  ? refreshLinearElement(
                      moveWaypoint(element, index, target),
                      previous,
                    )
                  : element,
              ),
            { commit: false, changedIds: [arrowId] },
          );
          return;
        }

        case "erasing": {
          accumulateErasures(interaction.lastWorld, point, event.altKey);
          interactionRef.current = { type: "erasing", lastWorld: point };
          return;
        }

        default:
          return;
      }
    },
    [
      accumulateErasures,
      applyDrag,
      applyElements,
      applyEndpointDrag,
      applyResize,
      elementsRef,
      getWorldPoint,
      patchVisuals,
      setPending,
      setSelectedIds,
      setViewport,
      updateDrawnGeometry,
      updateHoverCursor,
      worldThreshold,
    ],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      activePointersRef.current.delete(event.pointerId);

      const canvas = canvasRef.current;
      if (canvas?.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      if (activePointersRef.current.size > 0) {
        // If one finger was lifted while in pinch, stay idle until all fingers release
        interactionRef.current = { type: "idle" };
        resetVisuals();
        return;
      }

      const interaction = interactionRef.current;
      interactionRef.current = { type: "idle" };

      const point = getWorldPoint(event);

      switch (interaction.type) {
        case "drawing":
        case "freedraw": {
          const origin =
            interaction.type === "drawing" ? interaction.origin : point;
          finishDrawing(interaction.element, origin, point);
          break;
        }

        case "rotating":
        case "dragging":
        case "resizing": {
          const ids = new Set(
            interaction.snapshot.map((element) => element.id),
          );

          applyElements(
            (previous) =>
              settleBindingsAfterMove(
                previous,
                ids,
                worldThreshold(MAX_BINDING_GAP_PX),
              ),
            { changedIds: [...ids] },
          );
          break;
        }

        case "endpoint": {
          const { arrowId, which } = interaction;
          const gap = worldThreshold(MAX_BINDING_GAP_PX);

          applyElements(
            (previous) => {
              const arrow = previous.find((item) => item.id === arrowId);

              if (!arrow || !canBindToShapes(arrow)) {
                // A plain line keeps the end exactly where it was dropped.
                return previous;
              }

              const hovered = getHoveredBindableElement(
                point,
                previous,
                gap,
                arrowId,
              );
              const binding = hovered
                ? createBinding(hovered, point, gap)
                : null;

              return applyBindings(
                previous,
                arrowId,
                which === "start" ? { start: binding } : { end: binding },
              );
            },
            { changedIds: [arrowId] },
          );
          break;
        }

        case "waypoint": {
          const { arrowId, index } = interaction;

          applyElements(
            (previous) =>
              previous.map((element) => {
                if (element.id !== arrowId || !isLinearShape(element)) {
                  return element;
                }

                // A bend dropped back onto the straight line between its
                // neighbours is not a bend; drop it rather than leaving an
                // invisible handle behind.
                const controls = getControlPoints(element);
                const previousPoint = controls[index];
                const nextPoint = controls[index + 2];
                const bend = controls[index + 1];

                if (previousPoint && nextPoint && bend) {
                  const deviation = distanceToSegment(
                    bend.x,
                    bend.y,
                    previousPoint.x,
                    previousPoint.y,
                    nextPoint.x,
                    nextPoint.y,
                  );

                  if (deviation < worldThreshold(4)) {
                    return refreshLinearElement(
                      removeWaypoint(element, index),
                      previous,
                    );
                  }
                }

                return element;
              }),
            { changedIds: [arrowId] },
          );
          break;
        }

        case "erasing":
          commitErasures();
          break;

        default:
          break;
      }

      if (interaction.type !== "erasing") {
        resetVisuals();
      }

      updateHoverCursor(point);
    },
    [
      applyElements,
      canvasRef,
      commitErasures,
      finishDrawing,
      getWorldPoint,
      resetVisuals,
      updateHoverCursor,
      worldThreshold,
    ],
  );

  const cancel = useCallback(() => {
    const interaction = interactionRef.current;
    interactionRef.current = { type: "idle" };

    if (
      interaction.type === "dragging" ||
      interaction.type === "resizing" ||
      interaction.type === "rotating"
    ) {
      // Put the elements back exactly as they were before the gesture.
      const snapshot = interaction.snapshot;
      const byId = new Map(snapshot.map((element) => [element.id, element]));
      applyElements(
        (previous) =>
          previous.map((element) => byId.get(element.id) ?? element),
        { commit: false, broadcast: "elements" },
      );
    }

    setPending(null);
    resetVisuals();
  }, [applyElements, resetVisuals, setPending]);

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      activePointersRef.current.delete(event.pointerId);
      const canvas = canvasRef.current;
      if (canvas?.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      cancel();
    },
    [cancel, canvasRef],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      event.preventDefault();

      const point = getWorldPoint(event);
      const hit = getElementAtPoint(
        point,
        elementsRef.current,
        worldThreshold(HIT_THRESHOLD_PX),
        true,
      );

      if (hit?.tool === "Text") {
        onEditText(hit.id);
        return;
      }

      if (hit && isTextContainer(hit)) {
        // Double-clicking a shape edits its label, as in Excalidraw.
        onCreateText(point, hit.id);
        return;
      }

      if (!hit) {
        onCreateText(point, null);
      }
    },
    [elementsRef, getWorldPoint, onCreateText, onEditText, worldThreshold],
  );

  const cursor = useMemo(() => {
    const interaction = interactionRef.current;

    if (interaction.type === "panning") {
      return "grabbing";
    }
    if (interaction.type === "dragging") {
      return "move";
    }
    if (interaction.type === "rotating") {
      return "grabbing";
    }
    if (interaction.type === "resizing" && visuals.activeHandle) {
      return getHandleCursor(visuals.activeHandle);
    }
    return hoverCursor;
  }, [hoverCursor, visuals.activeHandle]);

  return {
    pendingElement,
    visuals,
    cursor,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onDoubleClick,
    },
    cancel,
  };
};
