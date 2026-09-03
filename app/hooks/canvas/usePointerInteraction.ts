"use client";

/**
 * The single pointer state machine for the canvas.
 *
 * Interaction state lives in a ref, so a fast pointer stream never reads a
 * stale closure; only the parts the interactive layer has to draw are mirrored
 * into React state.
 *
 * Interaction math and strategy algorithms are delegated to modules under
 * `./interactions/` (drawing, transform, eraser, types).
 */
import { useCallback, useMemo, useRef, useState } from "react";

import { useLatest } from "../useLatest";
import {
  isLinearShape,
  isTextContainer,
  type ElementStyle,
  type ElementType,
  type Point,
  type Shape,
  type ToolType,
  type Viewport,
} from "../../types/shapes";
import {
  createElement,
  duplicateElement,
} from "../../services/canvas/elements";
import {
  getElementAtPoint,
  getElementsInBox,
  getHandleCursor,
  getHandleIndex,
  getTransformHandleAtPoint,
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
} from "../../services/canvas/bindings";
import { getSelectionBounds } from "../../services/canvas/transform";
import {
  snapToPoint,
  SNAP_POINT_THRESHOLD_PX,
} from "../../services/canvas/pointSnapping";
import {
  boxCenter,
  distanceToSegment,
  normalizeBox,
} from "../../utils/geometry";
import { clampZoom, clientToWorld, zoomAtPoint } from "../../utils/viewport";
import type { ApplyOptions, ElementsUpdater } from "./useScene";

import {
  canBindToShapes,
  DRAG_THRESHOLD_PX,
  DRAWING_TOOLS,
  EMPTY_VISUALS,
  FREEHAND_MIN_SPACING_PX,
  type Interaction,
  type InteractionVisuals,
} from "./interactions/types";
import {
  finishDrawing,
  resolveDrawnLinear,
  updateDrawnGeometry,
} from "./interactions/drawing";
import {
  applyDragTransform,
  applyEndpointDragTransform,
  applyResizeTransform,
  applyRotationTransform,
} from "./interactions/transform";
import {
  accumulateEraserHits,
  commitEraserDeletions,
} from "./interactions/eraser";

export type { InteractionVisuals } from "./interactions/types";

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
  const selectedIdsRef = useLatest(selectedIds);
  const styleRef = useLatest(style);
  const toolRef = useLatest(tool);

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
    [elementsRef, selectedIdsRef],
  );

  /* ------------------------------------------------------------------ *
   * Interaction context bundles for strategy functions
   * ------------------------------------------------------------------ */

  const drawingCtx = useMemo(
    () => ({
      elementsRef,
      applyElements,
      worldThreshold,
      setPending,
      setSelectedIds,
      setTool,
      toolLocked,
    }),
    [
      elementsRef,
      applyElements,
      worldThreshold,
      setPending,
      setSelectedIds,
      setTool,
      toolLocked,
    ],
  );

  const transformCtx = useMemo(
    () => ({
      elementsRef,
      applyElements,
      patchVisuals,
      worldThreshold,
      applyPointSnap,
    }),
    [elementsRef, applyElements, patchVisuals, worldThreshold, applyPointSnap],
  );

  const eraserCtx = useMemo(
    () => ({
      elementsRef,
      erasingRef,
      trailRef,
      selectedIdsRef,
      patchVisuals,
      resetVisuals,
      applyElements,
      setSelectedIds,
      worldThreshold,
    }),
    [
      elementsRef,
      selectedIdsRef,
      patchVisuals,
      resetVisuals,
      applyElements,
      setSelectedIds,
      worldThreshold,
    ],
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
        accumulateEraserHits(point, point, event.altKey, eraserCtx);
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
      beginPan,
      canvasRef,
      elementsRef,
      eraserCtx,
      getSelectedElements,
      getWorldPoint,
      onCreateText,
      onEditText,
      setPending,
      setSelectedIds,
      setTool,
      selectedIdsRef,
      styleRef,
      toolRef,
      spacePressedRef,
      toolLocked,
      viewportRef,
      worldThreshold,
      applyPointSnap,
      applyElements,
      resetVisuals,
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
      toolRef,
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
            elementsRef.current,
          );

          const { element: next, endTargetId } = resolveDrawnLinear(
            geometry,
            interaction.startTargetId,
            interaction.origin,
            target,
            elementsRef.current,
            worldThreshold(MAX_BINDING_GAP_PX),
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

          const next = {
            ...interaction.element,
            points: [...interaction.element.points, point.x, point.y],
          };

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

          applyDragTransform(
            snapshot,
            {
              x: point.x - interaction.origin.x,
              y: point.y - interaction.origin.y,
            },
            !event.ctrlKey && !event.metaKey,
            transformCtx,
          );
          return;
        }

        case "dragging": {
          applyDragTransform(
            interaction.snapshot,
            {
              x: point.x - interaction.origin.x,
              y: point.y - interaction.origin.y,
            },
            !event.ctrlKey && !event.metaKey,
            transformCtx,
          );
          return;
        }

        case "rotating": {
          applyRotationTransform(
            interaction.snapshot,
            interaction.pivot,
            interaction.grabOffset,
            point,
            event.shiftKey,
            transformCtx,
          );
          return;
        }

        case "resizing": {
          applyResizeTransform(
            interaction.snapshot,
            interaction.initialBounds,
            interaction.handle,
            point,
            { shiftKey: event.shiftKey, altKey: event.altKey },
            transformCtx,
          );
          return;
        }

        case "endpoint": {
          applyEndpointDragTransform(
            interaction.arrowId,
            interaction.which,
            point,
            event.shiftKey,
            transformCtx,
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
          accumulateEraserHits(
            interaction.lastWorld,
            point,
            event.altKey,
            eraserCtx,
          );
          interactionRef.current = { type: "erasing", lastWorld: point };
          return;
        }

        default:
          return;
      }
    },
    [
      applyPointSnap,
      canvasRef,
      elementsRef,
      getWorldPoint,
      patchVisuals,
      setPending,
      setSelectedIds,
      setViewport,
      transformCtx,
      eraserCtx,
      updateHoverCursor,
      worldThreshold,
      applyElements,
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
          finishDrawing(interaction.element, origin, point, drawingCtx);
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
          commitEraserDeletions(eraserCtx);
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
      drawingCtx,
      eraserCtx,
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
