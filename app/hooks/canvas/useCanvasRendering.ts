/**
 * Custom hook for handling canvas rendering operations
 */
import { useCallback, RefObject } from "react";
import { RoughCanvas } from "roughjs/bin/canvas";
import { Shape, ShapeType } from "../../types/shapes";
import {
  drawShape,
  getShapeBoundingBox,
} from "../../services/canvas/drawingService";
import { drawSelectionHandles } from "../../utils/canvasUtils";

export interface UseCanvasRenderingProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  roughCanvasRef: RefObject<RoughCanvas>;
  shapes: Shape[];
  currentShape: Shape | null;
  selectedId: string | number | null;
  isMouseDown: boolean;
  userId: string | null;
  // Infinite canvas props
  zoom?: number;
  panOffset?: { x: number; y: number };
  isInfiniteCanvas?: boolean;
}

/**
 * Hook to manage canvas rendering operations
 */
export const useCanvasRendering = ({
  canvasRef,
  roughCanvasRef,
  shapes,
  currentShape,
  selectedId,
  isMouseDown,
  userId,
  // Infinite canvas props
  zoom = 1,
  panOffset = { x: 0, y: 0 },
  isInfiniteCanvas = false,
}: UseCanvasRenderingProps) => {
  /**
   * Identify if a shape belongs to a collaborator
   */
  const isCollaboratorShape = useCallback(
    (shape: Shape): boolean => {
      return !!shape.userId && shape.userId !== userId;
    },
    [userId]
  );

  /**
   * Compute active shapes categorized by owner
   */
  const getActiveShapes = useCallback(() => {
    const collaboratorShapes = shapes.filter(isCollaboratorShape);
    const currentUserShapes = shapes.filter((s) => !isCollaboratorShape(s));

    return {
      collaboratorShapes,
      currentUserShapes,
    };
  }, [shapes, isCollaboratorShape]);

  /**
   * Clear the canvas
   */
  const clearCanvas = useCallback(() => {
    if (!canvasRef.current) return;

    const context = canvasRef.current.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  }, [canvasRef]);

  /**
   * Draw all shapes on the canvas
   */
  const drawShapes = useCallback(
    (customHandlers?: {
      onBeforeDraw?: () => void;
      onAfterDraw?: () => void;
    }) => {
      if (!canvasRef.current || !roughCanvasRef.current) return;

      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      const roughCanvas = roughCanvasRef.current;

      if (!context) return;

      // Clear canvas
      context.clearRect(0, 0, canvas.width, canvas.height);

      if (customHandlers?.onBeforeDraw) {
        customHandlers.onBeforeDraw();
      }

      // Apply transformations for infinite canvas
      if (isInfiniteCanvas) {
        context.save();

        // First translate to account for panning
        context.translate(panOffset.x, panOffset.y);

        // Then apply zoom from the center
        context.scale(zoom, zoom);
      }

      const activeShapes = getActiveShapes();

      // Draw all regular shapes that belong to the current user
      activeShapes.currentUserShapes.forEach((shape) => {
        const isInProgress = shape.id === currentShape?.id && isMouseDown;
        const isSelected = shape.id === selectedId;
        drawShape(roughCanvas, context, shape, isInProgress, false);

        // Draw selection handles for selected shape
        if (isSelected) {
          const bounds = getShapeBoundingBox(shape);
          drawSelectionHandles(context, bounds, false);
        }
      });

      // Draw collaborator shapes with special styling
      activeShapes.collaboratorShapes.forEach((shape) => {
        const isInProgress = shape.isInProgress === true;
        drawShape(roughCanvas, context, shape, false, isInProgress);
      });

      // Draw current shape while drawing
      if (currentShape) {
        drawShape(roughCanvas, context, currentShape, true);
      }

      // Restore the context state if we're using infinite canvas
      if (isInfiniteCanvas) {
        context.restore();
      }

      if (customHandlers?.onAfterDraw) {
        customHandlers.onAfterDraw();
      }
    },
    [
      canvasRef,
      roughCanvasRef,
      getActiveShapes,
      currentShape,
      isMouseDown,
      selectedId,
      isInfiniteCanvas,
      zoom,
      panOffset,
    ]
  );

  return {
    clearCanvas,
    drawShapes,
    isCollaboratorShape,
    getActiveShapes,
  };
};
