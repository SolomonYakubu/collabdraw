/**
 * Custom hook for handling drag and resize operations on the canvas
 */
import { useState, useCallback, useRef } from "react";
import { Shape, BoundingBox } from "../../types/shapes";
import {
  getResizeHandleAtPosition,
  calculateNewBounds,
  updateShapeBounds,
  moveShape,
} from "../../utils/canvasUtils";
import {
  getShapeBoundingBox,
  isPointInShape,
} from "../../services/canvas/drawingService";

export interface UseCanvasInteractionsProps {
  shapes: Shape[];
  selectedId: string | number | null;
  onShapeUpdate?: (shape: Shape, action: string) => void;
}

export interface UseCanvasInteractionsResult {
  isDragging: boolean;
  resizeHandle: string | null;
  draggedShapeId: string | number | null;
  handleMouseDown: (
    x: number,
    y: number,
    selectedId: string | number | null
  ) => boolean;
  handleMouseMove: (x: number, y: number) => Shape | null;
  handleMouseUp: () => {
    dragComplete: boolean;
    resizeComplete: boolean;
    selectedId: string | number | null;
  };
  resetState: () => void;
}

/**
 * Hook to manage drag and resize operations on canvas shapes
 */
export const useCanvasInteractions = ({
  shapes,
  selectedId,
  onShapeUpdate,
}: UseCanvasInteractionsProps): UseCanvasInteractionsResult => {
  // State for tracking interactions
  const [isDragging, setIsDragging] = useState(false);
  const [draggedShapeId, setDraggedShapeId] = useState<string | number | null>(
    null
  );
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const [dragStartPosition, setDragStartPosition] = useState({ x: 0, y: 0 });
  const [initialBounds, setInitialBounds] = useState<BoundingBox | null>(null);

  // Keep original shape reference for transformations
  const originalShapeRef = useRef<Shape | null>(null);

  /**
   * Handle mouse down on the canvas
   * Returns true if the event was handled (drag or resize started)
   */
  const handleMouseDown = useCallback(
    (
      x: number,
      y: number,
      currentSelectedId: string | number | null
    ): boolean => {
      // If we have a selected shape, check if we're clicking on a resize handle
      if (currentSelectedId) {
        const shape = shapes.find((s) => s.id === currentSelectedId);

        if (shape) {
          const bounds = getShapeBoundingBox(shape);
          const handle = getResizeHandleAtPosition(x, y, bounds);

          if (handle) {
            // Start resize operation
            setResizeHandle(handle);
            setInitialBounds(bounds);
            originalShapeRef.current = shape;
            return true;
          }

          // Check if we're clicking on the shape itself to drag
          const { isInside } = isPointInShape(x, y, shape);
          if (isInside) {
            // Start drag operation
            startDragging(x, y, shape);
            return true;
          }
        }
      }

      return false;
    },
    [shapes]
  );

  /**
   * Start dragging a shape
   */
  const startDragging = (x: number, y: number, shape: Shape) => {
    setIsDragging(true);
    setDraggedShapeId(shape.id);
    originalShapeRef.current = { ...shape };

    // Calculate drag offset from shape origin
    setDragStartPosition({
      x: x - shape.x,
      y: y - shape.y,
    });
  };

  /**
   * Handle mouse move for drag or resize operations
   * Returns the updated shape if one was modified
   */
  const handleMouseMove = useCallback(
    (x: number, y: number): Shape | null => {
      // Handle drag operation
      if (isDragging && draggedShapeId) {
        const draggedShape = shapes.find((s) => s.id === draggedShapeId);
        if (!draggedShape || !originalShapeRef.current) return null;

        // Calculate new position
        const newX = x - dragStartPosition.x;
        const newY = y - dragStartPosition.y;

        // Create updated shape with new position
        const updatedShape = moveShape(originalShapeRef.current, newX, newY);

        if (onShapeUpdate) {
          onShapeUpdate(updatedShape, "move");
        }

        return updatedShape;
      }

      // Handle resize operation
      if (resizeHandle && initialBounds && selectedId) {
        const shape = shapes.find((s) => s.id === selectedId);
        if (!shape || !originalShapeRef.current) return null;

        // Calculate new bounds based on resize handle and mouse position
        const newBounds = calculateNewBounds(x, y, initialBounds, resizeHandle);
        if (!newBounds) return null;

        // Create updated shape with new bounds
        const resizedShape = updateShapeBounds(
          originalShapeRef.current,
          newBounds
        );

        if (onShapeUpdate) {
          onShapeUpdate(resizedShape, "resize");
        }

        return resizedShape;
      }

      return null;
    },
    [
      isDragging,
      draggedShapeId,
      shapes,
      resizeHandle,
      initialBounds,
      selectedId,
      onShapeUpdate,
    ]
  );

  /**
   * Handle mouse up to finish drag or resize operations
   */
  const handleMouseUp = useCallback(() => {
    const wasDragging = isDragging;
    const wasResizing = !!resizeHandle;
    const affectedId = draggedShapeId || selectedId;

    // Reset all state
    setIsDragging(false);
    setDraggedShapeId(null);
    setResizeHandle(null);
    setInitialBounds(null);
    originalShapeRef.current = null;

    // Return result of operation
    return {
      dragComplete: wasDragging,
      resizeComplete: wasResizing,
      selectedId: affectedId,
    };
  }, [isDragging, resizeHandle, draggedShapeId, selectedId]);

  /**
   * Reset all interaction state
   */
  const resetState = useCallback(() => {
    setIsDragging(false);
    setDraggedShapeId(null);
    setResizeHandle(null);
    setInitialBounds(null);
    originalShapeRef.current = null;
  }, []);

  return {
    isDragging,
    resizeHandle,
    draggedShapeId,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    resetState,
  };
};
