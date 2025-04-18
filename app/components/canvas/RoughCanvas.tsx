/**
 * RoughCanvas component - Pure HTML Canvas with Rough.js rendering
 * Refactored with modular hooks for better testability and maintainability
 */
import { useRef, useEffect, forwardRef, useState, useCallback } from "react";
import rough from "roughjs";
import { RoughCanvas as RoughJsCanvas } from "roughjs/bin/canvas";
import { Shape, ShapeType, BoundingBox } from "../../types/shapes";
import { CursorPositionsMap } from "../../types/collaboration";
import {
  isPointInShape,
  getShapeBoundingBox,
} from "../../services/canvas/drawingService";
import CollaborationCursors from "./CollaborationCursors";

// Import our new modular hooks
import { useAlignmentGuides } from "../../hooks/canvas/useAlignmentGuides";
import { useCanvasInteractions } from "../../hooks/canvas/useCanvasInteractions";
import { useCanvasRendering } from "../../hooks/canvas/useCanvasRendering";
// We're NOT using the useCanvasEventHandlers hook here directly

interface RoughCanvasProps {
  width: number;
  height: number;
  shapes: Shape[];
  currentShape: Shape | null;
  selectedId: string | number | null;
  setSelectedId: (id: string | number | null) => void;
  onMouseDown: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  onMouseMove: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  onMouseUp: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  onDblClick?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  cursors?: CursorPositionsMap;
  selectedTool: ShapeType;
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  enableDragWithoutSelect?: boolean;
  setIsDragging?: (dragging: boolean) => void;
  userId?: string | null;
  showGuides?: boolean; // Enable/disable alignment guides
  // Infinite canvas props
  zoom?: number;
  panOffset?: { x: number; y: number };
  isPanning?: boolean;
  setIsPanning?: (isPanning: boolean) => void;
  isInfiniteCanvas?: boolean;
  lastPanPointRef?: React.MutableRefObject<{ x: number; y: number }>;
}

const RoughCanvasComponent = forwardRef<HTMLCanvasElement, RoughCanvasProps>(
  (
    {
      width,
      height,
      shapes,
      currentShape,
      selectedId,
      setSelectedId,
      onMouseDown: parentMouseDown,
      onMouseMove: parentMouseMove,
      onMouseUp: parentMouseUp,
      onDblClick,
      cursors = {},
      selectedTool,
      onCanvasReady,
      enableDragWithoutSelect = false,
      setIsDragging: parentSetIsDragging,
      userId = null,
      showGuides = true,
      // Infinite canvas props
      zoom = 1,
      panOffset = { x: 0, y: 0 },
      isPanning = false,
      setIsPanning,
      isInfiniteCanvas = false,
    },
    ref
  ) => {
    const canvasRef = ref as React.RefObject<HTMLCanvasElement>;
    const roughCanvasRef = useRef<RoughJsCanvas | null>(null);
    const [isMouseDown, setIsMouseDown] = useState(false);
    const lastPanPositionRef = useRef({ x: 0, y: 0 });

    // Initialize alignment guides hook
    const {
      alignmentGuides,
      findAlignmentGuides,
      drawAlignmentGuides,
      clearAlignmentGuides,
      snapShapeToGuides,
    } = useAlignmentGuides({
      shapes,
      snapThreshold: 5,
    });

    // Initialize canvas interactions hook
    const {
      isDragging,
      resizeHandle,
      draggedShapeId,
      handleMouseDown: interactionsMouseDown,
      handleMouseMove: interactionsMouseMove,
      handleMouseUp: interactionsMouseUp,
    } = useCanvasInteractions({
      shapes,
      selectedId,
      onShapeUpdate: (shape, action) => {
        // Find alignment guides when dragging/resizing
        if ((action === "move" || action === "resize") && showGuides) {
          findAlignmentGuides(shape);

          // Apply snapping if guides exist
          const snappedShape = snapShapeToGuides(shape);

          // Create a simulated event to send to parent
          const simulatedEvent = {
            ...new MouseEvent("mousemove"),
            updatedShape: snappedShape,
            action,
          } as any;

          parentMouseMove(simulatedEvent);
        } else {
          // No guides needed, just update
          const simulatedEvent = {
            ...new MouseEvent("mousemove"),
            updatedShape: shape,
            action,
          } as any;

          parentMouseMove(simulatedEvent);
        }
      },
    });

    // Initialize canvas rendering hook
    const { drawShapes } = useCanvasRendering({
      canvasRef,
      roughCanvasRef,
      shapes,
      currentShape,
      selectedId,
      isMouseDown,
      userId,
      // Add infinite canvas properties
      zoom,
      panOffset,
      isInfiniteCanvas,
    });

    // Get canvas-relative coordinates from a mouse event, applying zoom and pan transformations
    const getCanvasCoordinates = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
        if (!canvasRef.current) return { x: 0, y: 0 };

        const rect = canvasRef.current.getBoundingClientRect();
        const viewX = e.clientX - rect.left;
        const viewY = e.clientY - rect.top;

        if (isInfiniteCanvas) {
          // Transform window coordinates to canvas coordinates with zoom and pan
          return {
            x: (viewX - panOffset.x) / zoom,
            y: (viewY - panOffset.y) / zoom,
          };
        }

        // Regular canvas coordinates
        return {
          x: viewX,
          y: viewY,
        };
      },
      [canvasRef, isInfiniteCanvas, zoom, panOffset]
    );

    // Update cursor style based on context
    const updateCursor = useCallback(
      (mouseX: number, mouseY: number) => {
        if (!canvasRef.current) return;

        // Set default cursor based on tool
        let cursor = "default";

        if (selectedTool === "Pan") {
          cursor = isPanning ? "grabbing" : "grab";
        } else if (selectedTool !== "Select" && selectedTool !== "Pan") {
          cursor = "crosshair";
        }

        // Override for resize handles
        if (resizeHandle) {
          switch (resizeHandle) {
            case "nw":
            case "se":
              cursor = "nwse-resize";
              break;
            case "ne":
            case "sw":
              cursor = "nesw-resize";
              break;
            case "n":
            case "s":
              cursor = "ns-resize";
              break;
            case "e":
            case "w":
              cursor = "ew-resize";
              break;
          }
        }
        // Override for dragging
        else if (isDragging) {
          cursor = "move";
        }
        // Check if hovering over a shape
        else if (selectedTool === "Select") {
          for (const shape of shapes) {
            // Convert mouse position to canvas coordinates if using infinite canvas
            const coordX = isInfiniteCanvas ? mouseX : mouseX;
            const coordY = isInfiniteCanvas ? mouseY : mouseY;

            const { isInside } = isPointInShape(coordX, coordY, shape);
            if (isInside) {
              cursor = "move";
              break;
            }
          }
        }

        canvasRef.current.style.cursor = cursor;
      },
      [
        canvasRef,
        isDragging,
        resizeHandle,
        selectedTool,
        shapes,
        isPanning,
        isInfiniteCanvas,
      ]
    );

    // Update parent component about drag state
    useEffect(() => {
      if (parentSetIsDragging) {
        parentSetIsDragging(isDragging);
      }
    }, [isDragging, parentSetIsDragging]);

    // Initialize rough canvas once the canvas element is available
    useEffect(() => {
      if (!canvasRef.current) return;

      roughCanvasRef.current = rough.canvas(canvasRef.current);

      if (onCanvasReady) {
        onCanvasReady(canvasRef.current);
      }
    }, [canvasRef, onCanvasReady]);

    // Redraw canvas when shapes change or we have a new current shape
    useEffect(() => {
      if (!canvasRef.current || !roughCanvasRef.current) return;

      // Use our rendering hook to draw shapes
      drawShapes({
        onAfterDraw: () => {
          // Draw alignment guides if needed
          if (
            showGuides &&
            alignmentGuides.length > 0 &&
            (isDragging || !!resizeHandle)
          ) {
            const context = canvasRef.current?.getContext("2d");
            if (context) {
              // Apply transformations for infinite canvas
              if (isInfiniteCanvas) {
                context.save();
                context.translate(panOffset.x, panOffset.y);
                context.scale(zoom, zoom);
                drawAlignmentGuides(context);
                context.restore();
              } else {
                drawAlignmentGuides(context);
              }
            }
          }
        },
      });
    }, [
      shapes,
      currentShape,
      width,
      height,
      isMouseDown,
      alignmentGuides,
      isDragging,
      resizeHandle,
      selectedId,
      showGuides,
      drawShapes,
      drawAlignmentGuides,
      isInfiniteCanvas,
      zoom,
      panOffset,
    ]);

    // Handle mouse down event
    const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();

      // Set mouse down state
      setIsMouseDown(true);

      // Handle Pan tool
      if (selectedTool === "Pan") {
        if (setIsPanning) setIsPanning(true);
        lastPanPositionRef.current = {
          x: e.clientX,
          y: e.clientY,
        };
        return;
      }

      // Get mouse coordinates
      const coords = getCanvasCoordinates(e);

      // Check if this is a drag or resize operation
      const wasHandled = interactionsMouseDown(coords.x, coords.y, selectedId);

      if (wasHandled) {
        // The operation was handled by the interactions hook
        return;
      }

      // === SELECTION VS DRAWING LOGIC ===

      // CASE 1: Using Select tool - always prioritize selection
      if (selectedTool === "Select") {
        for (let i = shapes.length - 1; i >= 0; i--) {
          const shape = shapes[i];
          const { isInside } = isPointInShape(coords.x, coords.y, shape);

          if (isInside) {
            // Select the shape without starting a drag operation
            setSelectedId(shape.id);
            return;
          }
        }

        // If nothing found, deselect
        if (selectedId) {
          setSelectedId(null);
        }

        // Call parent handler since no shape was selected
        parentMouseDown(e);
        return;
      }

      // CASE 2: Using a drawing tool - implement selection vs. drawing logic

      // Check if Alt key is pressed (force drawing mode)
      const isAltKeyPressed = e.altKey;
      const isShiftKeyPressed = e.shiftKey;

      // If Alt key is pressed, always pass through to drawing handler
      if (isAltKeyPressed) {
        parentMouseDown(e);
        return;
      }

      // Otherwise, check if we clicked on a shape
      let clickedShape: Shape | null = null;
      let isNearEdge = false;

      for (let i = shapes.length - 1; i >= 0; i--) {
        const shape = shapes[i];
        const { isInside } = isPointInShape(coords.x, coords.y, shape);

        if (isInside) {
          clickedShape = shape;

          // Check if we're near the edge of the shape
          const bounds = getShapeBoundingBox(shape);

          // Calculate distances to edges
          const distanceFromLeft = Math.abs(coords.x - bounds.x);
          const distanceFromRight = Math.abs(
            coords.x - (bounds.x + bounds.width)
          );
          const distanceFromTop = Math.abs(coords.y - bounds.y);
          const distanceFromBottom = Math.abs(
            coords.y - (bounds.y + bounds.height)
          );

          // Consider near edge if within 5 pixels of any edge
          const edgeThreshold = 5; // pixels
          isNearEdge =
            distanceFromLeft <= edgeThreshold ||
            distanceFromRight <= edgeThreshold ||
            distanceFromTop <= edgeThreshold ||
            distanceFromBottom <= edgeThreshold;

          break;
        }
      }

      // Decision logic for handling the event:
      if (clickedShape) {
        // We clicked on a shape

        // If shift is pressed with drawing tool, prioritize selection
        if (isShiftKeyPressed) {
          setSelectedId(clickedShape.id);
          return;
        }

        // If near edge with drawing tool, prioritize drawing
        if (isNearEdge) {
          parentMouseDown(e);
          return;
        }

        // If in center of shape, prioritize selection
        setSelectedId(clickedShape.id);
        return;
      }

      // No shape clicked - pass through to drawing handler
      parentMouseDown(e);
    };

    // Handle mouse move event
    const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();

      // Handle Pan tool
      if (isMouseDown && selectedTool === "Pan" && isInfiniteCanvas) {
        const dx = e.clientX - lastPanPositionRef.current.x;
        const dy = e.clientY - lastPanPositionRef.current.y;

        // Create a custom pan event to send to the parent
        const panEvent = {
          ...e,
          action: "pan",
          dx,
          dy,
        } as any;

        parentMouseMove(panEvent);

        // Update last position
        lastPanPositionRef.current = {
          x: e.clientX,
          y: e.clientY,
        };
        return;
      }

      // Get mouse coordinates
      const coords = getCanvasCoordinates(e);

      // Update cursor style
      updateCursor(coords.x, coords.y);

      // Check for drag or resize operations
      const updatedShape = interactionsMouseMove(coords.x, coords.y);

      if (updatedShape) {
        // Find the shape in the current shapes array
        const shapeIndex = shapes.findIndex((s) => s.id === updatedShape.id);

        if (shapeIndex !== -1) {
          // Update the shape in the shapes array
          const updatedShapes = [...shapes];
          updatedShapes[shapeIndex] = updatedShape;

          // Create event with updated shape for parent
          const simulatedEvent = {
            ...e,
            updatedShape,
            updatedShapes,
            action: isDragging ? "move" : "resize",
          };

          // Call parent handler with updated shape
          parentMouseMove(simulatedEvent);
        }
        return;
      }

      // Pass through to parent handler
      parentMouseMove(e);
    };

    // Handle mouse up event
    const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();

      // Reset mouse down state
      setIsMouseDown(false);

      // Reset panning state if needed
      if (selectedTool === "Pan" && setIsPanning) {
        setIsPanning(false);

        const panEvent = {
          ...e,
          action: "panEnd",
        } as any;

        parentMouseUp(panEvent);
        return;
      }

      // Complete any drag or resize operations
      const {
        dragComplete,
        resizeComplete,
        selectedId: affectedId,
      } = interactionsMouseUp();

      // Clear alignment guides
      clearAlignmentGuides();

      // Notify parent about completed operation
      if ((dragComplete || resizeComplete) && affectedId) {
        // Create event with operation complete flag
        const simulatedEvent = {
          ...e,
          dragComplete,
          resizeComplete,
          selectedId: affectedId,
        } as any;

        parentMouseUp(simulatedEvent);
        return;
      }

      // Pass through to parent handler
      parentMouseUp(e);
    };

    return (
      <div
        className={`relative ${isInfiniteCanvas ? "w-full h-full" : ""}`}
        style={isInfiniteCanvas ? {} : { width, height }}
      >
        <canvas
          width={width}
          height={height}
          ref={canvasRef}
          className={`${
            isInfiniteCanvas ? "absolute" : "border border-gray-300 bg-white"
          } shadow-sm rounded-xl`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onDoubleClick={onDblClick}
          style={{
            cursor:
              selectedTool === "Select"
                ? "default"
                : selectedTool === "Pan"
                ? isPanning
                  ? "grabbing"
                  : "grab"
                : "crosshair",
            touchAction: "none", // Prevents scrolling on mobile
            position: isInfiniteCanvas ? "absolute" : "relative",
            left: isInfiniteCanvas ? "50%" : 0,
            top: isInfiniteCanvas ? "50%" : 0,
            transform: isInfiniteCanvas
              ? `translate(-50%, -50%) translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`
              : "none",
            transformOrigin: "center center",
            backgroundColor: "white",
            boxShadow: isInfiniteCanvas
              ? "0 0 0 1px rgba(0,0,0,0.05), 0 4px 10px rgba(0,0,0,0.1)"
              : "none",
          }}
        />

        {/* Render collaboration cursors with userId */}
        {Object.keys(cursors || {}).length > 0 && (
          <CollaborationCursors
            cursors={cursors}
            currentUserId={userId}
            zoom={zoom}
            panOffset={panOffset}
            isInfiniteCanvas={isInfiniteCanvas}
          />
        )}
      </div>
    );
  }
);

RoughCanvasComponent.displayName = "RoughCanvas";

export default RoughCanvasComponent;
