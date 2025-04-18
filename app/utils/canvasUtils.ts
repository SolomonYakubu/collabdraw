/**
 * Canvas utility functions for RoughCanvas operations
 */
import { Shape, BoundingBox, ShapeType } from "../types/shapes";
import { getShapeBoundingBox } from "../services/canvas/drawingService";

/**
 * Check if a position is on a resize handle
 */
export const getResizeHandleAtPosition = (
  x: number,
  y: number,
  bounds: BoundingBox
): string | null => {
  const handleSize = 10;
  const halfHandleSize = handleSize / 2;

  const handles = [
    { id: "top-left", x: bounds.x, y: bounds.y },
    { id: "top-center", x: bounds.x + bounds.width / 2, y: bounds.y },
    { id: "top-right", x: bounds.x + bounds.width, y: bounds.y },
    { id: "middle-left", x: bounds.x, y: bounds.y + bounds.height / 2 },
    {
      id: "middle-right",
      x: bounds.x + bounds.width,
      y: bounds.y + bounds.height / 2,
    },
    { id: "bottom-left", x: bounds.x, y: bounds.y + bounds.height },
    {
      id: "bottom-center",
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height,
    },
    {
      id: "bottom-right",
      x: bounds.x + bounds.width,
      y: bounds.y + bounds.height,
    },
  ];

  for (const handle of handles) {
    if (
      x >= handle.x - halfHandleSize &&
      x <= handle.x + halfHandleSize &&
      y >= handle.y - halfHandleSize &&
      y <= handle.y + halfHandleSize
    ) {
      return handle.id;
    }
  }

  return null;
};

/**
 * Calculate new bounds during resize operation
 */
export const calculateNewBounds = (
  mouseX: number,
  mouseY: number,
  initialBounds: BoundingBox,
  resizeHandle: string
): BoundingBox | null => {
  if (!initialBounds || !resizeHandle) return null;

  let newBounds = { ...initialBounds };

  switch (resizeHandle) {
    case "top-left":
      newBounds.width = Math.max(
        5,
        initialBounds.x + initialBounds.width - mouseX
      );
      newBounds.height = Math.max(
        5,
        initialBounds.y + initialBounds.height - mouseY
      );
      newBounds.x = initialBounds.x + initialBounds.width - newBounds.width;
      newBounds.y = initialBounds.y + initialBounds.height - newBounds.height;
      break;
    case "top-center":
      newBounds.height = Math.max(
        5,
        initialBounds.y + initialBounds.height - mouseY
      );
      newBounds.y = initialBounds.y + initialBounds.height - newBounds.height;
      break;
    case "top-right":
      newBounds.width = Math.max(5, mouseX - initialBounds.x);
      newBounds.height = Math.max(
        5,
        initialBounds.y + initialBounds.height - mouseY
      );
      newBounds.y = initialBounds.y + initialBounds.height - newBounds.height;
      break;
    case "middle-left":
      newBounds.width = Math.max(
        5,
        initialBounds.x + initialBounds.width - mouseX
      );
      newBounds.x = initialBounds.x + initialBounds.width - newBounds.width;
      break;
    case "middle-right":
      newBounds.width = Math.max(5, mouseX - initialBounds.x);
      break;
    case "bottom-left":
      newBounds.width = Math.max(
        5,
        initialBounds.x + initialBounds.width - mouseX
      );
      newBounds.height = Math.max(5, mouseY - initialBounds.y);
      newBounds.x = initialBounds.x + initialBounds.width - newBounds.width;
      break;
    case "bottom-center":
      newBounds.height = Math.max(5, mouseY - initialBounds.y);
      break;
    case "bottom-right":
      newBounds.width = Math.max(5, mouseX - initialBounds.x);
      newBounds.height = Math.max(5, mouseY - initialBounds.y);
      break;
  }

  return newBounds;
};

/**
 * Update shape bounds for resizing operations
 */
export const updateShapeBounds = (shape: Shape, bounds: BoundingBox): Shape => {
  const updatedShape = { ...shape };

  switch (shape.tool) {
    case "Square":
    case "Circle":
      updatedShape.x = bounds.x;
      updatedShape.y = bounds.y;
      updatedShape.width = bounds.width;
      updatedShape.height = bounds.height;
      break;

    case "Line":
    case "Arrow":
      // For lines, we need to recalculate endpoints based on new bounds
      const oldBounds = getShapeBoundingBox(shape);

      // Calculate scaling factors
      const scaleX = bounds.width / oldBounds.width;
      const scaleY = bounds.height / oldBounds.height;

      // Apply transform to points
      updatedShape.x = bounds.x;
      updatedShape.y = bounds.y;

      // Transform x1,y1
      const dx1 = (shape.x1 - oldBounds.x) * scaleX;
      const dy1 = (shape.y1 - oldBounds.y) * scaleY;
      updatedShape.x1 = bounds.x + dx1;
      updatedShape.y1 = bounds.y + dy1;

      // Transform x2,y2
      const dx2 = (shape.x2 - oldBounds.x) * scaleX;
      const dy2 = (shape.y2 - oldBounds.y) * scaleY;
      updatedShape.x2 = bounds.x + dx2;
      updatedShape.y2 = bounds.y + dy2;
      break;

    case "Text":
      updatedShape.x = bounds.x;
      updatedShape.y = bounds.y;
      updatedShape.width = bounds.width;
      updatedShape.height = bounds.height;
      break;

    case "Freehand":
      // For freehand, scale all points to the new bounds
      const freehandShape = shape as any;
      if (
        !Array.isArray(freehandShape.points) ||
        freehandShape.points.length === 0
      ) {
        break;
      }

      const originalBounds = getShapeBoundingBox(shape);
      const newPoints: number[] = [];

      // Scale each point
      for (let i = 0; i < freehandShape.points.length; i += 2) {
        const originalX = freehandShape.points[i];
        const originalY = freehandShape.points[i + 1];

        // Calculate relative position within original bounds
        const relX = (originalX - originalBounds.x) / originalBounds.width;
        const relY = (originalY - originalBounds.y) / originalBounds.height;

        // Apply to new bounds
        const newX = bounds.x + relX * bounds.width;
        const newY = bounds.y + relY * bounds.height;

        newPoints.push(newX, newY);
      }

      updatedShape.x = bounds.x;
      updatedShape.y = bounds.y;
      updatedShape.points = newPoints;
      break;
  }

  return updatedShape;
};

/**
 * Move a shape to a new position
 */
export const moveShape = (shape: Shape, newX: number, newY: number): Shape => {
  const updatedShape = { ...shape };

  switch (shape.tool) {
    case "Square":
    case "Circle":
    case "Text":
      updatedShape.x = newX;
      updatedShape.y = newY;
      break;

    case "Line":
    case "Arrow":
      // Calculate delta from original position
      const deltaX = newX - shape.x;
      const deltaY = newY - shape.y;

      // Move both points by the delta
      updatedShape.x = newX;
      updatedShape.y = newY;
      updatedShape.x1 = shape.x1 + deltaX;
      updatedShape.y1 = shape.y1 + deltaY;
      updatedShape.x2 = shape.x2 + deltaX;
      updatedShape.y2 = shape.y2 + deltaY;
      break;

    case "Freehand":
      const freehandShape = shape as any;
      if (
        !Array.isArray(freehandShape.points) ||
        freehandShape.points.length === 0
      ) {
        break;
      }

      // Calculate delta from original position
      const dx = newX - shape.x;
      const dy = newY - shape.y;

      // Move all points by delta
      const newPoints: number[] = [];
      for (let i = 0; i < freehandShape.points.length; i += 2) {
        newPoints.push(
          freehandShape.points[i] + dx,
          freehandShape.points[i + 1] + dy
        );
      }

      updatedShape.x = newX;
      updatedShape.y = newY;
      updatedShape.points = newPoints;
      break;
  }

  return updatedShape;
};

/**
 * Draw selection handles around a shape
 */
export const drawSelectionHandles = (
  context: CanvasRenderingContext2D,
  box: BoundingBox,
  isResizing: boolean = false
) => {
  const handleSize = 8;
  const halfHandleSize = handleSize / 2;

  // Draw selection outline
  context.save();
  context.strokeStyle = isResizing ? "#1a73e8" : "#4285f4";
  context.lineWidth = isResizing ? 2 : 1.5;
  context.setLineDash(isResizing ? [] : [5, 5]);
  context.strokeRect(box.x - 2, box.y - 2, box.width + 4, box.height + 4);
  context.setLineDash([]);

  // Define handle positions
  const handles = [
    { id: "top-left", x: box.x, y: box.y },
    { id: "top-center", x: box.x + box.width / 2, y: box.y },
    { id: "top-right", x: box.x + box.width, y: box.y },
    { id: "middle-left", x: box.x, y: box.y + box.height / 2 },
    { id: "middle-right", x: box.x + box.width, y: box.y + box.height / 2 },
    { id: "bottom-left", x: box.x, y: box.y + box.height },
    {
      id: "bottom-center",
      x: box.x + box.width / 2,
      y: box.y + box.height,
    },
    { id: "bottom-right", x: box.x + box.width, y: box.y + box.height },
  ];

  // Draw all handles
  handles.forEach((handle) => {
    context.fillStyle = "#ffffff";
    context.strokeStyle = isResizing ? "#1a73e8" : "#4285f4";
    context.lineWidth = 1;

    // Draw square handle
    context.beginPath();
    context.rect(
      handle.x - halfHandleSize,
      handle.y - halfHandleSize,
      handleSize,
      handleSize
    );
    context.fill();
    context.stroke();
  });

  context.restore();
};

/**
 * Get appropriate cursor style for the current context
 */
export const getCursorStyle = (
  mouseX: number,
  mouseY: number,
  selectedId: string | number | null,
  shapes: Shape[],
  selectedTool: ShapeType,
  resizeHandle: string | null
): string => {
  // Default cursor
  let cursorStyle = selectedTool === "Select" ? "default" : "crosshair";

  // Check for hover over selected shape
  if (selectedId) {
    const shape = shapes.find((s) => s.id === selectedId);
    if (shape) {
      // Check for hover over resize handles
      const bounds = getShapeBoundingBox(shape);
      const handle = getResizeHandleAtPosition(mouseX, mouseY, bounds);

      if (handle) {
        // Set appropriate resize cursor
        switch (handle) {
          case "top-left":
          case "bottom-right":
            cursorStyle = "nwse-resize";
            break;
          case "top-right":
          case "bottom-left":
            cursorStyle = "nesw-resize";
            break;
          case "top-center":
          case "bottom-center":
            cursorStyle = "ns-resize";
            break;
          case "middle-right":
          case "middle-left":
            cursorStyle = "ew-resize";
            break;
        }
      } else {
        // Check if we're inside the shape (for dragging)
        const { isInside } = isPointInShape(mouseX, mouseY, shape);
        if (isInside) {
          cursorStyle = "move";
        }
      }
    }
  }

  return cursorStyle;
};

/**
 * Check if a point is inside a shape
 * Simplified version that delegates to the drawing service
 */
export const isPointInShape = (
  x: number,
  y: number,
  shape: Shape
): { isInside: boolean; isOnEdge: boolean } => {
  // Import the actual implementation from drawing service
  // This is just a wrapper to keep the interface consistent
  const box = getShapeBoundingBox(shape);

  // Simple check for basic shapes
  const isInsideBox =
    x >= box.x &&
    x <= box.x + box.width &&
    y >= box.y &&
    y <= box.y + box.height;

  return {
    isInside: isInsideBox,
    isOnEdge: false,
  };
};
