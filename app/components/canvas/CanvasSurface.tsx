"use client";

/**
 * The drawing surface: two stacked canvases.
 *
 *  - the static canvas holds the elements. It only repaints when the scene, the
 *    viewport or the canvas size changes.
 *  - the interactive canvas holds selection, handles, guides, binding
 *    highlights, the marquee and the eraser trail. Repainting it costs nothing,
 *    so hover and selection feedback never re-generate element geometry.
 *
 * Each layer has its own effect and its own requestAnimationFrame, depending
 * only on its own inputs. They were once one effect whose dependency array was
 * the union of both layers', so an interactive-only change (a hover, a marquee
 * frame, an eraser point) re-ran the whole static repaint — the exact cost the
 * two layers exist to avoid. A burst of events on one layer still coalesces into
 * a single frame for that layer.
 */
import { useEffect, useRef } from "react";
import rough from "roughjs";
import type { RoughCanvas } from "roughjs/bin/canvas";

import type {
  AlignmentGuide,
  BoundingBox,
  Point,
  Shape,
  TransformHandle,
  Viewport,
} from "../../types/shapes";
import {
  renderInteractiveScene,
  renderStaticScene,
} from "../../services/canvas/renderer";

export interface CanvasSurfaceProps {
  size: { width: number; height: number };
  devicePixelRatio: number;
  viewport: Viewport;
  elements: readonly Shape[];
  pendingElement: Shape | null;
  erasingIds: ReadonlySet<string>;
  selectedElements: readonly Shape[];
  selectionBounds: BoundingBox | null;
  showHandles: boolean;
  isTransforming: boolean;
  marquee: BoundingBox | null;
  bindingHighlightElement: Shape | null;
  alignmentGuides: readonly AlignmentGuide[];
  eraserTrail: readonly Point[];
  activeHandle: TransformHandle | null;
  snapPoint: Point | null;
  cursor: string;
  /**
   * Dark mode inverts the element layer rather than re-rendering it, which is
   * how Excalidraw does it: elements are always drawn dark-on-light, so a black
   * stroke becomes near-white and colours keep their identity. The interactive
   * layer is left alone so selection and handles keep their own colours.
   */
  canvasFilter: string;
  /**
   * The interactive canvas is the pointer target; the interaction hook needs it
   * to measure the element and to take pointer capture.
   */
  interactiveCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onDoubleClick: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLCanvasElement>) => void;
}

const useCanvasBacking = (
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  size: { width: number; height: number },
  devicePixelRatio: number,
): void => {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const width = Math.max(1, Math.floor(size.width * devicePixelRatio));
    const height = Math.max(1, Math.floor(size.height * devicePixelRatio));

    // Assigning width/height clears the canvas, so only do it when it changed.
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }, [canvasRef, size.width, size.height, devicePixelRatio]);
};

const CanvasSurface: React.FC<CanvasSurfaceProps> = ({
  size,
  devicePixelRatio,
  viewport,
  elements,
  pendingElement,
  erasingIds,
  selectedElements,
  selectionBounds,
  showHandles,
  isTransforming,
  marquee,
  bindingHighlightElement,
  alignmentGuides,
  eraserTrail,
  activeHandle,
  snapPoint,
  cursor,
  canvasFilter,
  interactiveCanvasRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onDoubleClick,
  onContextMenu,
}) => {
  const staticCanvasRef = useRef<HTMLCanvasElement>(null);
  const roughCanvasRef = useRef<RoughCanvas | null>(null);
  const staticFrameRef = useRef<number | null>(null);
  const interactiveFrameRef = useRef<number | null>(null);

  useCanvasBacking(staticCanvasRef, size, devicePixelRatio);
  useCanvasBacking(interactiveCanvasRef, size, devicePixelRatio);

  useEffect(() => {
    const canvas = staticCanvasRef.current;
    if (canvas) {
      roughCanvasRef.current = rough.canvas(canvas);
    }
  }, []);

  // The element layer: repaints only when the scene, the viewport or the canvas
  // size changes — never for hover or selection feedback.
  useEffect(() => {
    if (staticFrameRef.current !== null) {
      cancelAnimationFrame(staticFrameRef.current);
    }

    staticFrameRef.current = requestAnimationFrame(() => {
      staticFrameRef.current = null;

      const canvas = staticCanvasRef.current;
      const roughCanvas = roughCanvasRef.current;
      if (canvas && roughCanvas) {
        renderStaticScene({
          canvas,
          roughCanvas,
          elements,
          viewport,
          devicePixelRatio,
          erasingIds,
          pendingElement,
        });
      }
    });

    return () => {
      if (staticFrameRef.current !== null) {
        cancelAnimationFrame(staticFrameRef.current);
        staticFrameRef.current = null;
      }
    };
  }, [
    devicePixelRatio,
    elements,
    erasingIds,
    pendingElement,
    size.height,
    size.width,
    viewport,
  ]);

  // The overlay: selection, handles, guides, the marquee and the eraser trail.
  // Its own frame, so a burst of pointer events costs one overlay repaint.
  useEffect(() => {
    if (interactiveFrameRef.current !== null) {
      cancelAnimationFrame(interactiveFrameRef.current);
    }

    interactiveFrameRef.current = requestAnimationFrame(() => {
      interactiveFrameRef.current = null;

      const canvas = interactiveCanvasRef.current;
      if (canvas) {
        renderInteractiveScene({
          canvas,
          viewport,
          devicePixelRatio,
          selectedElements,
          selectionBounds,
          isTransforming,
          showHandles,
          marquee,
          bindingHighlightElement,
          alignmentGuides,
          eraserTrail,
          activeHandle,
          snapPoint,
        });
      }
    });

    return () => {
      if (interactiveFrameRef.current !== null) {
        cancelAnimationFrame(interactiveFrameRef.current);
        interactiveFrameRef.current = null;
      }
    };
  }, [
    activeHandle,
    alignmentGuides,
    bindingHighlightElement,
    devicePixelRatio,
    eraserTrail,
    interactiveCanvasRef,
    isTransforming,
    marquee,
    selectedElements,
    selectionBounds,
    showHandles,
    size.height,
    size.width,
    snapPoint,
    viewport,
  ]);

  const dimensions = {
    width: `${size.width}px`,
    height: `${size.height}px`,
  };

  return (
    <>
      <canvas
        ref={staticCanvasRef}
        className="absolute left-0 top-0"
        style={{ ...dimensions, filter: canvasFilter, touchAction: "none" }}
      />
      <canvas
        ref={interactiveCanvasRef}
        className="absolute left-0 top-0"
        style={{ ...dimensions, cursor, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
    </>
  );
};

export default CanvasSurface;
