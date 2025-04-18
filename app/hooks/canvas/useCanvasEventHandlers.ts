/**
 * Custom hook for handling canvas mouse events and shape manipulation
 */
import { useCallback, useState, RefObject, useRef } from "react";
import { Shape, ShapeType, TextShape } from "../../types/shapes";
import {
  isPointInShape,
  createShape,
  getShapeBoundingBox,
} from "../../services/canvas/drawingService";
import { generateShapeId } from "../../services/canvas/drawingService";

// Configuration constants
const DRAG_DELAY_MS = 150; // Delay before selecting/dragging a shape
const DRAG_THRESHOLD_PX = 3; // How many pixels mouse must move to initiate drag
const EDGE_DRAWING_THRESHOLD_PX = 5; // Threshold for edge-based drawing detection

export interface UseCanvasEventHandlersProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  selectedTool: ShapeType;
  color: string;
  fillColor?: string; // Add fill color prop
  isDrawing: boolean;
  setIsDrawing: (isDrawing: boolean) => void;
  startPoint: { x: number; y: number } | null;
  setStartPoint: (point: { x: number; y: number } | null) => void;
  currentShape: Shape | null;
  setCurrentShape: (shape: Shape | null) => void;
  shapes: Shape[];
  setShapes: (shapes: Shape[] | ((prevShapes: Shape[]) => Shape[])) => void;
  selectedId: string | number | null;
  setSelectedId: (id: string | number | null) => void;
  saveToHistory: () => void;
  onShapeUpdated?: (shape: Shape) => void;
  isDragging: boolean;
  setIsDragging: (isDragging: boolean) => void;
  startTextEditing?: (id: string | number) => void;
  // Infinite canvas props
  isPanning?: boolean;
  setIsPanning?: (isPanning: boolean) => void;
  panOffset?: { x: number; y: number };
  setPanOffset?: (
    panOffset:
      | { x: number; y: number }
      | ((prev: { x: number; y: number }) => { x: number; y: number })
  ) => void;
  lastPanPointRef?: React.MutableRefObject<{ x: number; y: number }>;
  zoom?: number;
}

/**
 * Hook that provides canvas event handlers for drawing and manipulating shapes
 */
export const useCanvasEventHandlers = ({
  canvasRef,
  selectedTool,
  color,
  fillColor = "transparent", // Default to transparent if not provided
  isDrawing,
  setIsDrawing,
  startPoint,
  setStartPoint,
  currentShape,
  setCurrentShape,
  shapes,
  setShapes,
  selectedId,
  setSelectedId,
  saveToHistory,
  onShapeUpdated,
  isDragging,
  setIsDragging,
  startTextEditing,
  // Infinite canvas props
  isPanning,
  setIsPanning,
  panOffset,
  setPanOffset,
  lastPanPointRef,
  zoom = 1,
}: UseCanvasEventHandlersProps) => {
  // References for handling delayed selection and drag operations
  const clickTimerRef = useRef<NodeJS.Timeout | null>(null);
  const initialPositionRef = useRef<{ x: number; y: number } | null>(null);
  const potentialDragShapeRef = useRef<Shape | null>(null);
  // Add a ref to track mouse down state
  const isMouseDownRef = useRef(false);
  // Add a new ref to track drawing intent
  const drawingIntentRef = useRef(false);

  // Clear the selection timer safely
  const clearSelectionTimer = useCallback(() => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }, []);

  /**
   * Get canvas-relative coordinates from a mouse event
   */
  const getCanvasCoordinates = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
      if (!canvasRef.current) return { x: 0, y: 0 };

      const rect = canvasRef.current.getBoundingClientRect();
      const viewX = e.clientX - rect.left;
      const viewY = e.clientY - rect.top;

      // Apply zoom and pan transformations if we're using infinite canvas
      if (panOffset) {
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
    [canvasRef, panOffset, zoom]
  );

  /**
   * Create a new text shape at the given coordinates
   */
  const createTextShape = useCallback(
    (x: number, y: number): Shape | null => {
      const textShape = createShape("Text", { x, y, fill: fillColor }, color);
      if (!textShape) return null;

      return textShape;
    },
    [color, fillColor]
  );

  /**
   * Start drawing a new shape
   */
  const startDrawing = useCallback(
    (x: number, y: number, tool: ShapeType) => {
      setIsDrawing(true);
      setStartPoint({ x, y });

      // Create initial shape based on the selected tool
      const initialAttrs = {
        x,
        y,
        x1: x,
        y1: y,
        x2: x,
        y2: y,
        points: [x, y],
        fill: fillColor, // Add the fill color to the initial attributes
      };

      // Only pass drawable shape types to createShape
      const drawableTool = tool as
        | "Freehand"
        | "Line"
        | "Square"
        | "Circle"
        | "Diamond"
        | "Text"
        | "Arrow"
        | "Group";
      const newShape = createShape(drawableTool, initialAttrs, color);

      if (newShape) {
        // Set in-progress flag
        newShape.isInProgress = true;
        setCurrentShape(newShape);
      }
    },
    [setIsDrawing, setStartPoint, color, fillColor, setCurrentShape]
  );

  /**
   * Update the shape during drawing
   */
  const updateDrawing = useCallback(
    (x: number, y: number) => {
      if (!currentShape || !startPoint) return;

      // Update the shape based on its type
      switch (currentShape.tool) {
        case "Line":
        case "Arrow":
          // Update end point for line/arrow
          setCurrentShape({
            ...currentShape,
            x2: x,
            y2: y,
          });
          break;
        case "Square":
        case "Circle":
        case "Diamond":
          // Calculate width and height for rectangle/circle/diamond
          const width = x - startPoint.x;
          const height = y - startPoint.y;
          setCurrentShape({
            ...currentShape,
            width: Math.abs(width),
            height: Math.abs(height),
            x: width < 0 ? x : startPoint.x,
            y: height < 0 ? y : startPoint.y,
          });
          break;
        case "Freehand":
          // Add point to the freehand path
          setCurrentShape({
            ...currentShape,
            points: [...currentShape.points, x, y],
          });
          break;
        default:
          break;
      }
    },
    [currentShape, startPoint, setCurrentShape]
  );

  /**
   * Finish drawing a shape
   */
  const finishDrawing = useCallback(() => {
    if (!currentShape) return null;

    // Create a new completed shape without the in-progress flag
    const completedShape = {
      ...currentShape,
      isInProgress: false,
    };

    // Update the shapes array with the new shape
    setShapes((prevShapes) => [...prevShapes, completedShape]);

    // Notify about shape update if callback provided
    if (onShapeUpdated) {
      onShapeUpdated(completedShape);
    }

    // Save to history
    saveToHistory();

    // Reset current shape and drawing state
    setCurrentShape(null);
    setIsDrawing(false);
    setStartPoint(null);

    return completedShape;
  }, [
    currentShape,
    setShapes,
    saveToHistory,
    setCurrentShape,
    setIsDrawing,
    setStartPoint,
    onShapeUpdated,
  ]);

  /**
   * Determine if a point is near the edge of a shape
   * Returns true if the point is within the edge threshold of the shape
   */
  const isPointNearShapeEdge = useCallback(
    (x: number, y: number, shape: Shape): boolean => {
      // First check if the point is in the shape at all
      const { isInside } = isPointInShape(x, y, shape);
      if (!isInside) return false;

      // Get the bounding box of the shape
      const bounds = getShapeBoundingBox(shape);

      // Check if point is near any edge of the bounding box
      const distanceFromLeft = Math.abs(x - bounds.x);
      const distanceFromRight = Math.abs(x - (bounds.x + bounds.width));
      const distanceFromTop = Math.abs(y - bounds.y);
      const distanceFromBottom = Math.abs(y - (bounds.y + bounds.height));

      // If any edge is within threshold, it's near an edge
      return (
        distanceFromLeft <= EDGE_DRAWING_THRESHOLD_PX ||
        distanceFromRight <= EDGE_DRAWING_THRESHOLD_PX ||
        distanceFromTop <= EDGE_DRAWING_THRESHOLD_PX ||
        distanceFromBottom <= EDGE_DRAWING_THRESHOLD_PX
      );
    },
    []
  );

  /**
   * Handle mouse down event
   */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // Prevent default to stop browser's default behavior
      e.preventDefault();

      if (e.button !== 0) return; // Only handle left mouse button

      // Set mouse down state
      isMouseDownRef.current = true;

      // Clear any existing selection timer
      clearSelectionTimer();

      // Get coordinates
      const { x, y } = getCanvasCoordinates(e);
      initialPositionRef.current = { x, y };

      // If we're already drawing or dragging, ignore additional mouse downs
      if (isDrawing || isDragging) return;

      // Check for explicit drawing intent using Alt/Option key
      // This always prioritizes drawing over selection regardless of tool
      const isAltKeyPressed = e.altKey;
      const isShiftKeyPressed = e.shiftKey;
      drawingIntentRef.current = isAltKeyPressed;

      // Handle Pan tool
      if (selectedTool === "Pan" && setPanOffset && setIsPanning) {
        setIsPanning(true);
        if (lastPanPointRef) {
          lastPanPointRef.current = {
            x: e.clientX,
            y: e.clientY,
          };
        }
        return;
      }

      // Check if we're clicking on any shape
      let clickedShape: Shape | null = null;
      let isNearEdge = false;

      // Only do this check if we're not forcing drawing with Alt
      if (!isAltKeyPressed) {
        // Check if we're clicking on a shape (in reverse order to handle stacking)
        for (let i = shapes.length - 1; i >= 0; i--) {
          const shape = shapes[i];
          const { isInside } = isPointInShape(x, y, shape);

          if (isInside) {
            clickedShape = shape;
            isNearEdge = isPointNearShapeEdge(x, y, shape);
            break;
          }
        }
      }

      // CASE 1: Using Select tool
      if (selectedTool === "Select") {
        if (clickedShape) {
          // Store the shape for potential drag operation
          potentialDragShapeRef.current = clickedShape;

          // Select immediately - no delay needed in Select mode
          setSelectedId(clickedShape.id);
        } else {
          // Clicked on empty space, deselect
          setSelectedId(null);
        }
        return;
      }

      // CASE 2: Using Eraser tool
      else if (selectedTool === "Eraser") {
        // Start erasing operation
        setIsDrawing(true);

        // Import and use handleEraserAction from drawingService
        const {
          handleEraserAction,
        } = require("../../services/canvas/drawingService");

        // Find shapes to erase at current position
        const removedShapeIds = handleEraserAction(x, y, shapes);

        // If we found shapes to erase, update the shapes array
        if (removedShapeIds.length > 0) {
          setShapes((prevShapes) => {
            // Filter out erased shapes
            const newShapes = prevShapes.filter(
              (shape) => !removedShapeIds.includes(shape.id)
            );
            return newShapes;
          });

          // Save to history after erasing
          saveToHistory();
        }
        return;
      }

      // CASE 3: Using Text tool
      else if (selectedTool === "Text") {
        const textShape = createTextShape(x, y);
        if (textShape) {
          setShapes((prevShapes) => [...prevShapes, textShape]);
          setSelectedId(textShape.id);

          // Notify about shape update
          if (onShapeUpdated) {
            onShapeUpdated(textShape);
          }

          // Start editing the text immediately
          setTimeout(() => {
            if (startTextEditing) {
              startTextEditing(textShape.id);
            }
          }, 0);

          saveToHistory();
        }
        return;
      }

      // CASE 4: Using any drawing tool
      else if (
        ["Freehand", "Line", "Square", "Circle", "Arrow", "Diamond"].includes(
          selectedTool
        )
      ) {
        // Decision logic for whether to select or draw:

        // 1. If Alt key is pressed, always draw (handled earlier)
        // 2. If no shape is clicked, always draw
        // 3. If shape is clicked near edge, draw unless Shift is pressed
        // 4. If shape is clicked in center, select unless Alt is pressed

        if (clickedShape) {
          // We clicked on a shape

          // If Alt is pressed, we always draw (this works because drawingIntentRef is already set)
          if (isAltKeyPressed) {
            startDrawing(x, y, selectedTool);
            return;
          }

          // If near edge, prioritize drawing unless shift is pressed for selection
          if (isNearEdge && !isShiftKeyPressed) {
            startDrawing(x, y, selectedTool);
            return;
          }

          // If in center area, prioritize selection
          if (!isNearEdge) {
            setSelectedId(clickedShape.id);
            return;
          }
        }

        // If we get here, we should start drawing
        startDrawing(x, y, selectedTool);
        return;
      }
    },
    [
      getCanvasCoordinates,
      isDrawing,
      isDragging,
      selectedTool,
      shapes,
      setSelectedId,
      startDrawing,
      createTextShape,
      setShapes,
      onShapeUpdated,
      saveToHistory,
      startTextEditing,
      setIsDrawing,
      clearSelectionTimer,
      setIsPanning,
      setPanOffset,
      lastPanPointRef,
      isPointNearShapeEdge,
    ]
  );

  /**
   * Handle mouse move event
   */
  const handleMouseMove = useCallback(
    (e: any) => {
      // Check if this is a pan operation
      if (
        e.action === "pan" &&
        setPanOffset &&
        e.dx !== undefined &&
        e.dy !== undefined
      ) {
        setPanOffset((prev) => ({
          x: prev.x + e.dx,
          y: prev.y + e.dy,
        }));
        return;
      }

      // Handle pan tool directly
      if (
        selectedTool === "Pan" &&
        isMouseDownRef.current &&
        setPanOffset &&
        lastPanPointRef &&
        setIsPanning
      ) {
        if (isPanning) {
          const dx = e.clientX - lastPanPointRef.current.x;
          const dy = e.clientY - lastPanPointRef.current.y;

          setPanOffset((prev) => ({
            x: prev.x + dx,
            y: prev.y + dy,
          }));

          lastPanPointRef.current = {
            x: e.clientX,
            y: e.clientY,
          };
        }
        return;
      }

      const { x, y } = getCanvasCoordinates(e);

      // If we have an initial position and potential drag shape, check for drag threshold
      if (
        initialPositionRef.current &&
        potentialDragShapeRef.current &&
        !isDrawing
      ) {
        const dx = Math.abs(x - initialPositionRef.current.x);
        const dy = Math.abs(y - initialPositionRef.current.y);

        // If moved more than threshold, cancel the selection timer and select immediately
        if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) {
          clearSelectionTimer();
          setSelectedId(potentialDragShapeRef.current.id);
          potentialDragShapeRef.current = null;
        }
      }

      // Check if this is a shape update from a drag or resize operation
      if (e.updatedShape && e.updatedShapes) {
        // Direct update of shapes array from drag/resize operation
        setShapes(e.updatedShapes);

        // Notify collaborators about shape update if provided
        if (onShapeUpdated && !e.updatedShape.isInProgress) {
          onShapeUpdated(e.updatedShape);
        }
        return;
      }

      // Special handling for eraser tool when drawing
      if (isDrawing && selectedTool === "Eraser") {
        // Import and use handleEraserAction from drawingService
        const {
          handleEraserAction,
        } = require("../../services/canvas/drawingService");

        // Find shapes to erase at current position
        const removedShapeIds = handleEraserAction(x, y, shapes);

        // If we found shapes to erase, update the shapes array
        if (removedShapeIds.length > 0) {
          setShapes((prevShapes) => {
            // Filter out erased shapes
            return prevShapes.filter(
              (shape) => !removedShapeIds.includes(shape.id)
            );
          });

          // No need to save to history on every move - we'll do that on mouseup
        }
        return;
      }

      // If we're drawing, update the current shape
      if (isDrawing && currentShape) {
        updateDrawing(x, y);
      }
    },
    [
      getCanvasCoordinates,
      isDrawing,
      currentShape,
      updateDrawing,
      setShapes,
      onShapeUpdated,
      selectedTool,
      shapes,
      clearSelectionTimer,
      setSelectedId,
      setPanOffset,
      lastPanPointRef,
      isPanning,
      setIsPanning,
    ]
  );

  /**
   * Handle mouse up event
   */
  const handleMouseUp = useCallback(
    (e: any) => {
      // Reset mouse down state
      isMouseDownRef.current = false;
      // Reset drawing intent
      drawingIntentRef.current = false;

      // Reset our tracking references
      initialPositionRef.current = null;
      potentialDragShapeRef.current = null;

      // Handle Pan tool release
      if (selectedTool === "Pan" && setIsPanning) {
        setIsPanning(false);
        return;
      }

      // Handle pan event from RoughCanvas
      if (e.action === "panEnd" && setIsPanning) {
        setIsPanning(false);
        return;
      }

      // Check if this is a drag or resize operation completion
      if (e.dragComplete || e.resizeComplete) {
        saveToHistory();
        return;
      }

      // Special handling for Eraser tool
      if (isDrawing && selectedTool === "Eraser") {
        // Save the state after erasing is complete
        saveToHistory();
        setIsDrawing(false);
        return;
      }

      // If we were drawing, finish the shape
      if (isDrawing && currentShape) {
        // For Arrow and Line tools, check if the line is too short (just a click)
        if (
          (currentShape.tool === "Arrow" || currentShape.tool === "Line") &&
          "x1" in currentShape &&
          "y1" in currentShape &&
          "x2" in currentShape &&
          "y2" in currentShape
        ) {
          // Calculate distance between start and end points
          const dx = currentShape.x2 - currentShape.x1;
          const dy = currentShape.y2 - currentShape.y1;
          const distance = Math.sqrt(dx * dx + dy * dy);

          // If distance is too small (less than 5px), it was likely a click without drag
          if (distance < 5) {
            // Just cancel the drawing operation without adding the shape
            setCurrentShape(null);
            setIsDrawing(false);
            setStartPoint(null);
            return;
          }
        }

        // Proceed with finishing the drawing for all other shapes or valid arrows/lines
        finishDrawing();
      }
    },
    [
      isDrawing,
      currentShape,
      finishDrawing,
      saveToHistory,
      selectedTool,
      setIsDrawing,
      clearSelectionTimer,
      setIsPanning,
      setCurrentShape,
      setStartPoint,
    ]
  );

  return {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    createTextShape,
  };
};
