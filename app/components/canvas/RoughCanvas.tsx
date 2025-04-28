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
      roughCanvasRef: roughCanvasRef as React.RefObject<RoughJsCanvas>,
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

    // Ensure correct pixel size for retina and match container size
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth, clientHeight } = canvas;
      if (
        canvas.width !== clientWidth * dpr ||
        canvas.height !== clientHeight * dpr
      ) {
        canvas.width = clientWidth * dpr;
        canvas.height = clientHeight * dpr;
      }
    }, [width, height]);

    // Convert screen to world coords (inverse of context transform)
    const getCanvasCoordinates = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const viewX = (e.clientX - rect.left) * dpr;
        const viewY = (e.clientY - rect.top) * dpr;
        if (isInfiniteCanvas) {
          return {
            x: (viewX - dpr * panOffset.x) / (zoom * dpr),
            y: (viewY - dpr * panOffset.y) / (zoom * dpr),
          };
        }
        return { x: viewX, y: viewY };
      },
      [canvasRef, zoom, panOffset, isInfiniteCanvas]
    );

    // Update cursor style based on context
    const updateCursor = useCallback(
      (mouseX: number, mouseY: number) => {
        if (!canvasRef.current) return;

        // Set default cursor based on tool
        let cursor = "default";

        if (selectedTool === "Pan") {
          cursor = isPanning ? "grabbing" : "grab";
        } else if (selectedTool !== "Select") {
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
          // Use the already calculated world coordinates (mouseX, mouseY)
          for (const shape of shapes) {
            const { isInside } = isPointInShape(mouseX, mouseY, shape);
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
      setIsMouseDown(true);

      // Handle Pan tool first
      if (selectedTool === "Pan") {
        if (setIsPanning) setIsPanning(true);
        lastPanPositionRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      // Get world coordinates
      const coords = getCanvasCoordinates(e);

      // --- Revised Logic for Select Tool ---
      if (selectedTool === "Select") {
        // 1. Check for resize handle on the currently selected shape
        // Pass the *current* selectedId to check for resize handles
        const resizeStarted = interactionsMouseDown(
          coords.x,
          coords.y,
          selectedId
        );
        if (resizeStarted) {
          return; // Resize handled by interactions hook
        }

        // 2. Check if clicking inside ANY shape to select and potentially drag
        let clickedShape: Shape | null = null;
        for (let i = shapes.length - 1; i >= 0; i--) {
          const shape = shapes[i];
          const { isInside } = isPointInShape(coords.x, coords.y, shape);
          if (isInside) {
            clickedShape = shape;
            break;
          }
        }

        if (clickedShape) {
          // Select the clicked shape if it's not already selected
          if (selectedId !== clickedShape.id) {
            setSelectedId(clickedShape.id);
          }
          // Now, explicitly try to start the drag operation for the clicked shape
          // Pass the clickedShape.id to interactionsMouseDown
          interactionsMouseDown(coords.x, coords.y, clickedShape.id);
          // The interactions hook will now set isDragging state if applicable
          return;
        } else {
          // 3. Clicked on empty space - deselect
          if (selectedId) {
            setSelectedId(null);
          }
          // Do NOT call parentMouseDown for Select tool on empty space
          return;
        }
      }
      // --- End Revised Logic for Select Tool ---

      // --- Logic for Drawing Tools ---

      // Check Alt key (force drawing)
      const isAltKeyPressed = e.altKey;
      if (isAltKeyPressed) {
        parentMouseDown(e); // Pass to drawing handler
        return;
      }

      // Check Shift key (force selection with drawing tool)
      const isShiftKeyPressed = e.shiftKey;

      // Check if clicking on a shape with a drawing tool
      let clickedShapeDrawingTool: Shape | null = null;
      let isNearEdge = false;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const shape = shapes[i];
        const { isInside } = isPointInShape(coords.x, coords.y, shape);
        if (isInside) {
          clickedShapeDrawingTool = shape;
          // Check if near edge (using logic similar to original code)
          const bounds = getShapeBoundingBox(shape);
          const edgeThreshold = 5; // pixels
          const distanceFromLeft = Math.abs(coords.x - bounds.x);
          const distanceFromRight = Math.abs(
            coords.x - (bounds.x + bounds.width)
          );
          const distanceFromTop = Math.abs(coords.y - bounds.y);
          const distanceFromBottom = Math.abs(
            coords.y - (bounds.y + bounds.height)
          );
          isNearEdge =
            distanceFromLeft <= edgeThreshold ||
            distanceFromRight <= edgeThreshold ||
            distanceFromTop <= edgeThreshold ||
            distanceFromBottom <= edgeThreshold;
          break;
        }
      }

      if (clickedShapeDrawingTool) {
        // Shift pressed? Select it.
        if (isShiftKeyPressed) {
          setSelectedId(clickedShapeDrawingTool.id);
          return;
        }
        // Near edge? Draw.
        if (isNearEdge) {
          parentMouseDown(e); // Pass to drawing handler
          return;
        }
        // In center? Select it.
        setSelectedId(clickedShapeDrawingTool.id);
        return;
      }

      // No shape clicked with drawing tool? Draw.
      parentMouseDown(e); // Pass to drawing handler
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
      <div className="absolute inset-0 w-full h-full overflow-hidden bg-[#f0f0f0]">
        <canvas
          width={width}
          height={height}
          ref={canvasRef}
          className="absolute inset-0 w-full h-full bg-white shadow-sm rounded-xl"
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
            touchAction: "none",
          }}
        />
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
