"use client";

/**
 * Main Canvas component that integrates all drawing functionality
 */
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Shape, ShapeType } from "../types/shapes";
import {
  canvasToDataURL,
  isPointInShape,
} from "../services/canvas/drawingService";
import RoughCanvas from "./canvas/RoughCanvas";
import Toolbar from "./canvas/ui/Toolbar";
import ContextMenu from "./canvas/ui/ContextMenu";
import FillColorModal from "./canvas/ui/FillColorModal";
import { useCanvasEventHandlers } from "../hooks/canvas/useCanvasEventHandlers";
import { useHistory } from "../hooks/canvas/useHistory";
import { useTextEditing } from "../hooks/canvas/useTextEditing";
import { useCollaborationContext } from "../context/CollaborationContext";
import { FiUsers, FiZoomIn, FiZoomOut, FiMaximize2 } from "react-icons/fi";

interface CanvasProps {
  width?: number;
  height?: number;
  initialTool?: ShapeType;
  initialColor?: string;
  isCollaborative?: boolean;
  canvasRef?: React.RefObject<HTMLDivElement>;
}

const Canvas: React.FC<CanvasProps> = ({
  width = 800,
  height = 600,
  initialTool = "Freehand",
  initialColor = "#000000",
  isCollaborative = true,
}) => {
  // References
  const canvasRef = useRef<HTMLCanvasElement>(null!);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);

  // Reference to prevent infinite loops with isDragging state
  const isDraggingRef = useRef(false);

  // References for panning and zooming
  const isPanningRef = useRef(false);
  const lastPanPointRef = useRef({ x: 0, y: 0 });

  // Use collaboration context
  const {
    isConnected,
    users,
    inProgressShapes,
    shareableLink,
    showLinkCopied,
    copyShareableLink,
    sendCanvasData,
    sendShapeUpdate,
    sendShapeDeletion,
    sendShapeInProgress,
    sendDrawingState,
    userId,
    shapes,
    setShapes,
  } = useCollaborationContext();

  // Canvas state
  const [currentShape, setCurrentShape] = useState<Shape | null>(null);
  const [selectedId, setSelectedId] = useState<string | number | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(
    null
  );
  const [selectedTool, setSelectedTool] = useState<ShapeType>(initialTool);
  const [selectedColor, setSelectedColor] = useState<string>(initialColor);
  const [selectedFillColor, setSelectedFillColor] =
    useState<string>("transparent");
  const [showUserPanel, setShowUserPanel] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [editingText, setEditingText] = useState<{
    id: string | number;
    value: string;
    x: number;
    y: number;
  } | null>(null);

  // State for fill color modal
  const [fillColorModal, setFillColorModal] = useState<{
    visible: boolean;
    initialColor: string;
  }>({
    visible: false,
    initialColor: "transparent",
  });

  // Infinite canvas state
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
  }>({
    visible: false,
    x: 0,
    y: 0,
  });

  // State to track the default fill style for new shapes
  const [defaultFillStyle, setDefaultFillStyle] = useState<string>("hachure");

  // Update the ref when isDragging changes
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  // Update panning ref
  useEffect(() => {
    isPanningRef.current = isPanning;
  }, [isPanning]);

  // Share in-progress shape with collaborators when drawing
  useEffect(() => {
    if (isCollaborative && isConnected && currentShape && isDrawing) {
      sendShapeInProgress(currentShape);
    }
  }, [
    currentShape,
    isConnected,
    isCollaborative,
    sendShapeInProgress,
    isDrawing,
  ]);

  // Notify about drawing state changes
  useEffect(() => {
    if (isCollaborative && isConnected) {
      sendDrawingState(isDrawing);

      // If we stopped drawing, wait a bit and sync our completed shapes
      if (!isDrawing && shapes.length > 0) {
        // Clear any existing timeout
        if (syncTimeoutRef.current) {
          clearTimeout(syncTimeoutRef.current);
        }

        // Set a new timeout to sync shapes
        syncTimeoutRef.current = setTimeout(() => {
          console.log("Syncing shapes after drawing:", shapes.length);
          sendCanvasData(shapes);
          syncTimeoutRef.current = null;
        }, 500);
      }
    }
  }, [
    isDrawing,
    isConnected,
    isCollaborative,
    sendDrawingState,
    shapes,
    sendCanvasData,
  ]);

  // Set up history management
  const { saveToHistory, undo, redo, clear, canUndo, canRedo } = useHistory({
    canvasRef,
    shapes,
    setShapes,
    selectedId,
    onShapeUpdated: isCollaborative ? sendShapeUpdate : undefined,
  });

  // Set up text editing
  const { editingId, startTextEditing, endTextEditing } = useTextEditing({
    shapes,
    setShapes,
    selectedId,
    saveToHistory,
    onShapeUpdated: isCollaborative ? sendShapeUpdate : undefined,
    canvasRef: canvasContainerRef,
  });

  // Set up event handlers
  const eventHandlers = useCanvasEventHandlers({
    canvasRef,
    selectedTool,
    color: selectedColor,
    fillColor: selectedFillColor,
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
    onShapeUpdated: isCollaborative ? sendShapeUpdate : undefined,
    isDragging,
    setIsDragging: (newIsDragging) => {
      // Only update the state if it's actually changed to prevent infinite loops
      if (isDraggingRef.current !== newIsDragging) {
        setIsDragging(newIsDragging);
      }
    },
    startTextEditing,
    // For infinite canvas
    isPanning,
    setIsPanning,
    panOffset,
    setPanOffset,
    lastPanPointRef,
    zoom,
  });

  // Compute all shapes to be rendered (regular + in-progress)
  const allShapes = useMemo(() => {
    // Start with all completed shapes
    const displayShapes = [...shapes];

    // Add in-progress shapes from other users
    Object.values(inProgressShapes).forEach((shape) => {
      if (shape && shape.id) {
        // Check if this shape is already in our shapes array
        const existingIndex = displayShapes.findIndex((s) => s.id === shape.id);
        if (existingIndex === -1) {
          displayShapes.push(shape);
        }
      }
    });

    return displayShapes;
  }, [shapes, inProgressShapes]);

  // Handle zoom in operation
  const handleZoomIn = useCallback(() => {
    setZoom((prevZoom) => Math.min(prevZoom * 1.2, 5)); // Limit max zoom to 5x
  }, []);

  // Handle zoom out operation
  const handleZoomOut = useCallback(() => {
    setZoom((prevZoom) => Math.max(prevZoom / 1.2, 0.2)); // Limit min zoom to 0.2x
  }, []);

  // Reset zoom and pan to default
  const handleResetView = useCallback(() => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  // Handle wheel zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom((prevZoom) => {
          const newZoom = prevZoom * zoomFactor;
          return Math.max(0.2, Math.min(5, newZoom)); // Constrain zoom between 0.2 and 5
        });
      } else if (selectedTool === "Pan" || e.shiftKey) {
        // Pan with shift+scroll or when Pan tool is active
        e.preventDefault();
        setPanOffset((prev) => ({
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    },
    [selectedTool]
  );

  // Update the handleToolSelect function to properly clear states when switching tools
  const handleToolSelect = useCallback(
    (tool: ShapeType) => {
      // End text editing when switching tools
      if (editingId) {
        endTextEditing();
      }

      // Always deselect shapes when switching to any drawing tool
      if (tool !== "Select" && selectedId) {
        setSelectedId(null);
      }

      // If we're switching from a drawing tool to Select tool, don't reset any in-progress drawing
      // Otherwise, reset any drawing in progress
      if (selectedTool !== "Select" && tool !== "Select" && isDrawing) {
        setIsDrawing(false);
        setCurrentShape(null);
        setStartPoint(null);
      }

      setSelectedTool(tool);
    },
    [
      selectedId,
      editingId,
      endTextEditing,
      isDrawing,
      selectedTool,
      setIsDrawing,
      setCurrentShape,
      setStartPoint,
    ]
  );

  // Fix handleStageDblClick to ensure text creation works on double-click
  const handleStageDblClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault(); // Prevent any default behavior
      e.stopPropagation(); // Stop event propagation

      // Get coordinates relative to canvas
      const rect = canvasRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - panOffset.x) / zoom;
      const y = (e.clientY - rect.top - panOffset.y) / zoom;

      // If text shape is selected, edit it
      if (selectedId) {
        const selectedShape = shapes.find(
          (shape) => shape.id === selectedId && shape.tool === "Text"
        );
        if (selectedShape) {
          startTextEditing(selectedId);
          return;
        }
      }

      // Create text on double click regardless of selected tool
      // This makes it work like Figma/Excalidraw where double-click always creates text
      const textShape = eventHandlers.createTextShape(x, y);
      if (textShape) {
        // Deselect any previously selected shape
        if (selectedId) {
          setSelectedId(null);
        }

        const updatedShapes = [...shapes, textShape];
        setShapes(updatedShapes);
        setSelectedId(textShape.id);
        saveToHistory();

        // Start editing immediately
        setTimeout(() => {
          startTextEditing(textShape.id);
        }, 0);

        // Notify collaborators
        if (isCollaborative && isConnected) {
          sendShapeUpdate(textShape);
        }
      }
    },
    [
      shapes,
      selectedId,
      eventHandlers,
      startTextEditing,
      setShapes,
      saveToHistory,
      isCollaborative,
      isConnected,
      sendShapeUpdate,
      setSelectedId,
      canvasRef,
      panOffset,
      zoom,
    ]
  );

  // Handle right-click to show context menu
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      // Get coordinates
      const rect = canvasRef.current.getBoundingClientRect();
      const x = e.clientX;
      const y = e.clientY;

      // Show context menu at mouse position
      setContextMenu({
        visible: true,
        x,
        y,
      });
    },
    [canvasRef]
  );

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu({
      ...contextMenu,
      visible: false,
    });
  }, [contextMenu]);

  // Handle duplicate shape action
  const handleDuplicate = useCallback(() => {
    if (!selectedId) return;

    // Find the selected shape
    const shapeToClone = shapes.find((shape) => shape.id === selectedId);
    if (!shapeToClone) return;

    // Create a new copy of the shape with a new ID
    const clonedShape = {
      ...shapeToClone,
      id: `${shapeToClone.id}_copy_${Date.now()}`,
      x: (shapeToClone.x || 0) + 20, // Offset slightly
      y: (shapeToClone.y || 0) + 20,
    };

    // Add to shapes array
    setShapes([...shapes, clonedShape]);

    // Select the new shape
    setSelectedId(clonedShape.id);

    // Save to history
    saveToHistory();

    // Notify collaborators if needed
    if (isCollaborative && isConnected && sendShapeUpdate) {
      sendShapeUpdate(clonedShape);
    }

    // Close context menu
    closeContextMenu();
  }, [
    selectedId,
    shapes,
    setShapes,
    saveToHistory,
    isCollaborative,
    isConnected,
    sendShapeUpdate,
    closeContextMenu,
    setSelectedId,
  ]);

  // Handle delete shape action
  const handleDeleteShape = useCallback(() => {
    if (!selectedId) return;

    // Remove the selected shape
    setShapes((prevShapes) =>
      prevShapes.filter((shape) => shape.id !== selectedId)
    );
    setSelectedId(null);

    // Save to history
    saveToHistory();

    // Notify collaborators if in collaborative mode
    if (isCollaborative && isConnected && sendShapeDeletion) {
      sendShapeDeletion(selectedId);
    }

    // Close context menu
    closeContextMenu();
  }, [
    selectedId,
    setShapes,
    saveToHistory,
    isCollaborative,
    isConnected,
    sendShapeDeletion,
    closeContextMenu,
    setSelectedId,
  ]);

  // Handle changing fill color
  const handleChangeFillColor = useCallback(() => {
    if (!selectedId) return;

    // Find the selected shape to get its current fill color
    const selectedShape = shapes.find((shape) => shape.id === selectedId);
    if (!selectedShape) return;

    // Open the fill color modal with the current fill color
    setFillColorModal({
      visible: true,
      initialColor: selectedShape.fill || "transparent",
    });

    // Close context menu
    closeContextMenu();
  }, [selectedId, shapes, closeContextMenu]);

  // Handle fill color change
  const handleFillColorChange = useCallback(
    (color: string) => {
      if (!selectedId) return;

      // Update the shape's fill color and roughOptions for sketchy fill
      setShapes((prevShapes) =>
        prevShapes.map((shape) => {
          if (shape.id === selectedId) {
            // Enhanced sketchy fill options - increased roughness for more sketch-like appearance
            const updatedShape = {
              ...shape,
              fill: color,
              roughOptions: {
                ...(shape.roughOptions || {}),
                fillStyle: color !== "transparent" ? "hachure" : undefined,
                roughness: 2.5,
                fillWeight: 2,
                hachureAngle: Math.random() * 60 + 30, // Random angle between 30-90 degrees
                hachureGap: 5, // Smaller gap for more visible hatching
                disableMultiStroke: false, // Enable multiple strokes
                disableMultiStrokeFill: false, // Enable multiple strokes for fill
              },
            };

            // Notify collaborators if needed
            if (isCollaborative && isConnected && sendShapeUpdate) {
              sendShapeUpdate(updatedShape);
            }

            return updatedShape;
          }
          return shape;
        })
      );

      // Save to history
      saveToHistory();

      // Close the modal
      setFillColorModal({
        visible: false,
        initialColor: "transparent",
      });
    },
    [
      selectedId,
      setShapes,
      saveToHistory,
      isCollaborative,
      isConnected,
      sendShapeUpdate,
    ]
  );

  // Handle changing the fill color of a selected shape from the toolbar
  const handleSelectedShapeFillChange = useCallback(
    (color: string, customRoughOptions?: any) => {
      if (!selectedId) return;

      // Update the shape's fill color and roughOptions for sketchy fill
      setShapes((prevShapes) =>
        prevShapes.map((shape) => {
          if (shape.id === selectedId) {
            // Enhanced sketchy fill options with more randomized parameters for a hand-drawn look
            const updatedShape = {
              ...shape,
              fill: color,
              roughOptions: {
                ...(shape.roughOptions || {}),
                ...(customRoughOptions || {
                  fillStyle: color !== "transparent" ? "hachure" : undefined,
                  roughness: 2.5,
                  fillWeight: 0.5,
                  hachureAngle: Math.random() * 60 + 30,
                  hachureGap: 5,
                  disableMultiStroke: false,
                  disableMultiStrokeFill: false,
                }),
              },
            };

            // Notify collaborators if needed
            if (isCollaborative && isConnected && sendShapeUpdate) {
              sendShapeUpdate(updatedShape);
            }

            return updatedShape;
          }
          return shape;
        })
      );

      // Save to history
      saveToHistory();
    },
    [
      selectedId,
      setShapes,
      saveToHistory,
      isCollaborative,
      isConnected,
      sendShapeUpdate,
    ]
  );

  useEffect(() => {
    // Start editing newly created text shapes automatically
    if (selectedId) {
      const selectedShape = shapes.find((s) => s.id === selectedId);
      if (selectedShape?.tool === "Text" && !selectedShape.text) {
        startTextEditing(selectedId);
      }
    }
  }, [selectedId, shapes, startTextEditing]);

  // Add keyboard shortcut event listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip shortcuts when editing text
      if (editingId !== null) return;

      // Skip if we're in an input field
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      // Undo: Ctrl+Z or Cmd+Z
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "z" &&
        !e.shiftKey
      ) {
        e.preventDefault();
        undo();
      }

      // Redo: Ctrl+Shift+Z or Cmd+Shift+Z or Ctrl+Y or Cmd+Y
      if (
        (e.ctrlKey || e.metaKey) &&
        ((e.key.toLowerCase() === "z" && e.shiftKey) ||
          e.key.toLowerCase() === "y")
      ) {
        e.preventDefault();
        redo();
      }

      // Delete: Delete or Backspace
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        // Remove the selected shape
        setShapes((prevShapes) =>
          prevShapes.filter((shape) => shape.id !== selectedId)
        );
        setSelectedId(null);

        // Save to history
        saveToHistory();

        // Notify collaborators if in collaborative mode
        if (isCollaborative && isConnected && sendShapeDeletion) {
          sendShapeDeletion(selectedId);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    undo,
    redo,
    selectedId,
    setShapes,
    saveToHistory,
    editingId,
    isCollaborative,
    isConnected,
    sendShapeDeletion,
    setSelectedId,
    shapes,
  ]);

  // Generate share link
  const handleGenerateLink = useCallback(() => {
    copyShareableLink();
  }, [copyShareableLink]);

  // Toggle user panel
  const toggleUserPanel = useCallback(() => {
    setShowUserPanel((prev) => !prev);
  }, []);

  // Save canvas as image
  const saveToImage = useCallback(() => {
    if (!canvasRef.current) return;

    try {
      const dataURL = canvasToDataURL(canvasRef.current);
      if (!dataURL) return;

      const link = document.createElement("a");
      link.download = `collabdraw-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = dataURL;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("Error saving canvas as image:", error);
      alert("Failed to save the canvas as an image.");
    }
  }, [canvasRef]);

  // Cleanup function for when component unmounts
  useEffect(() => {
    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, []);

  // --- Layer ordering functions ---
  // Bring shape forward one level
  const handleBringForward = useCallback(() => {
    if (!selectedId) return;

    setShapes((prevShapes) => {
      const index = prevShapes.findIndex((shape) => shape.id === selectedId);
      if (index === -1 || index === prevShapes.length - 1) return prevShapes; // Can't bring forward if already at top

      const newShapes = [...prevShapes];
      const shapeToMove = newShapes[index];

      // Remove the shape from its current position
      newShapes.splice(index, 1);
      // Add it one position up
      newShapes.splice(index + 1, 0, shapeToMove);

      // Notify collaborators if needed
      if (isCollaborative && isConnected && sendShapeUpdate) {
        // We need to update with the full new shapes array for proper ordering
        sendCanvasData(newShapes);
      }

      return newShapes;
    });

    saveToHistory();
    closeContextMenu();
  }, [
    selectedId,
    setShapes,
    saveToHistory,
    closeContextMenu,
    isCollaborative,
    isConnected,
    sendShapeUpdate,
    sendCanvasData,
  ]);

  // Send shape backward one level
  const handleSendBackward = useCallback(() => {
    if (!selectedId) return;

    setShapes((prevShapes) => {
      const index = prevShapes.findIndex((shape) => shape.id === selectedId);
      if (index <= 0) return prevShapes; // Can't send backward if already at bottom

      const newShapes = [...prevShapes];
      const shapeToMove = newShapes[index];

      // Remove the shape from its current position
      newShapes.splice(index, 1);
      // Add it one position down
      newShapes.splice(index - 1, 0, shapeToMove);

      // Notify collaborators if needed
      if (isCollaborative && isConnected && sendShapeUpdate) {
        // We need to update with the full new shapes array for proper ordering
        sendCanvasData(newShapes);
      }

      return newShapes;
    });

    saveToHistory();
    closeContextMenu();
  }, [
    selectedId,
    setShapes,
    saveToHistory,
    closeContextMenu,
    isCollaborative,
    isConnected,
    sendShapeUpdate,
    sendCanvasData,
  ]);

  // Bring shape to the very front
  const handleBringToFront = useCallback(() => {
    if (!selectedId) return;

    setShapes((prevShapes) => {
      const index = prevShapes.findIndex((shape) => shape.id === selectedId);
      if (index === -1 || index === prevShapes.length - 1) return prevShapes; // Already at front

      const newShapes = [...prevShapes];
      const shapeToMove = newShapes.splice(index, 1)[0];
      newShapes.push(shapeToMove); // Add to end (top of stack)

      // Notify collaborators if needed
      if (isCollaborative && isConnected && sendShapeUpdate) {
        // We need to update with the full new shapes array for proper ordering
        sendCanvasData(newShapes);
      }

      return newShapes;
    });

    saveToHistory();
    closeContextMenu();
  }, [
    selectedId,
    setShapes,
    saveToHistory,
    closeContextMenu,
    isCollaborative,
    isConnected,
    sendShapeUpdate,
    sendCanvasData,
  ]);

  // Send shape to the very back
  const handleSendToBack = useCallback(() => {
    if (!selectedId) return;

    setShapes((prevShapes) => {
      const index = prevShapes.findIndex((shape) => shape.id === selectedId);
      if (index <= 0) return prevShapes; // Already at back

      const newShapes = [...prevShapes];
      const shapeToMove = newShapes.splice(index, 1)[0];
      newShapes.unshift(shapeToMove); // Add to beginning (bottom of stack)

      // Notify collaborators if needed
      if (isCollaborative && isConnected && sendShapeUpdate) {
        // We need to update with the full new shapes array for proper ordering
        sendCanvasData(newShapes);
      }

      return newShapes;
    });

    saveToHistory();
    closeContextMenu();
  }, [
    selectedId,
    setShapes,
    saveToHistory,
    closeContextMenu,
    isCollaborative,
    isConnected,
    sendShapeUpdate,
    sendCanvasData,
  ]);

  return (
    <div className="canvas-container flex flex-col gap-4 ">
      <Toolbar
        selectedTool={selectedTool}
        onSelectTool={handleToolSelect}
        selectedColor={selectedColor}
        onSelectColor={setSelectedColor}
        selectedFillColor={selectedFillColor}
        onSelectFillColor={setSelectedFillColor}
        onClearCanvas={clear}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        onSave={saveToImage}
        onGenerateLink={isCollaborative ? handleGenerateLink : undefined}
        shareableLink={shareableLink}
        showLinkCopied={showLinkCopied}
        toggleUserPanel={isCollaborative ? toggleUserPanel : undefined}
        hasSelectedShape={selectedId !== null}
        selectedShapeFill={
          selectedId
            ? shapes.find((shape) => shape.id === selectedId)?.fill ||
              "transparent"
            : "transparent"
        }
        selectedShapeOptions={
          selectedId
            ? shapes.find((shape) => shape.id === selectedId)?.roughOptions
            : undefined
        }
        onChangeSelectedShapeFill={handleSelectedShapeFillChange}
        defaultFillStyle={defaultFillStyle}
      />

      <div
        className="infinite-canvas-container relative overflow-hidden rounded-xl border border-gray-200 shadow-inner"
        ref={canvasContainerRef}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
        style={{
          width: "100%",
          height: "calc(100vh - 140px)",
          minHeight: "400px",
        }}
      >
        <div className="absolute top-3 left-3 z-40 flex gap-2 bg-white/90 backdrop-blur-sm p-2 rounded-lg shadow-sm">
          <button
            className="p-2 rounded-md hover:bg-blue-50 hover:text-blue-600 text-gray-700 transition-colors"
            onClick={handleZoomIn}
            title="Zoom in"
          >
            <FiZoomIn size={18} />
          </button>
          <button
            className="p-2 rounded-md hover:bg-blue-50 hover:text-blue-600 text-gray-700 transition-colors"
            onClick={handleZoomOut}
            title="Zoom out"
          >
            <FiZoomOut size={18} />
          </button>
          <button
            className="p-2 rounded-md hover:bg-blue-50 hover:text-blue-600 text-gray-700 transition-colors"
            onClick={handleResetView}
            title="Reset view"
          >
            <FiMaximize2 size={18} />
          </button>
          <div className="flex items-center px-3 text-sm font-medium text-gray-700 min-w-16 justify-center">
            {Math.round(zoom * 100)}%
          </div>
        </div>

        <RoughCanvas
          ref={canvasRef}
          width={width}
          height={height}
          shapes={allShapes}
          currentShape={currentShape}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          onMouseDown={eventHandlers.handleMouseDown}
          onMouseMove={eventHandlers.handleMouseMove}
          onMouseUp={eventHandlers.handleMouseUp}
          onDblClick={handleStageDblClick}
          selectedTool={selectedTool}
          enableDragWithoutSelect={true}
          cursors={
            isCollaborative
              ? users.reduce((acc, user) => {
                  if (user && user.id && user.cursor) {
                    acc[user.id] = user.cursor;
                  }
                  return acc;
                }, {})
              : {}
          }
          setIsDragging={setIsDragging}
          userId={userId}
          zoom={zoom}
          panOffset={panOffset}
          isPanning={isPanning}
          setIsPanning={setIsPanning}
          isInfiniteCanvas={true}
          lastPanPointRef={lastPanPointRef}
        />

        {/* Collaborative users panel */}
        {isCollaborative && showUserPanel && users.length > 0 && (
          <div className="user-panel absolute top-3 right-3 bg-white/95 p-5 rounded-xl shadow-lg border border-gray-200 z-50 backdrop-blur-sm transition-all duration-200 ease-in-out hover:shadow-xl animate-fadeIn">
            <h3 className="text-sm font-semibold mb-4 text-gray-800 flex items-center border-b border-gray-100 pb-3">
              <FiUsers className="mr-2 text-blue-600" size={18} />
              Connected Users ({users.length})
            </h3>
            <ul className="space-y-3">
              {users.map((user) => (
                <li
                  key={user.id}
                  className="flex items-center text-sm p-2 hover:bg-gray-50 rounded-lg transition-colors duration-150"
                >
                  <div className="relative">
                    <div className="w-3 h-3 mr-3 rounded-full bg-green-500 connection-indicator"></div>
                    <div className="absolute inset-0 w-3 h-3 rounded-full bg-green-500 animate-ping opacity-75"></div>
                  </div>
                  <span className="text-gray-700 font-medium">{user.tag}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Connection status indicator */}
        {isCollaborative && (
          <div
            className={`absolute bottom-3 left-3 px-3 py-1.5 rounded-lg text-xs font-medium flex items-center z-50 ${
              isConnected
                ? "bg-green-50 text-green-700"
                : "bg-red-50 text-red-700"
            } shadow-sm backdrop-blur-sm`}
          >
            <div
              className={`w-2.5 h-2.5 mr-2 rounded-full ${
                isConnected ? "bg-green-500 connection-indicator" : "bg-red-500"
              }`}
            ></div>
            {isConnected ? "Connected" : "Offline"}
          </div>
        )}

        {/* Context menu */}
        {contextMenu.visible && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={closeContextMenu}
            onDuplicate={handleDuplicate}
            onDelete={handleDeleteShape}
            onChangeFillColor={handleChangeFillColor}
            onBringForward={handleBringForward}
            onSendBackward={handleSendBackward}
            onBringToFront={handleBringToFront}
            onSendToBack={handleSendToBack}
            isShapeSelected={selectedId !== null}
            isMultipleSelection={false}
          />
        )}

        {/* Fill Color Modal */}
        <FillColorModal
          isOpen={fillColorModal.visible}
          onClose={() =>
            setFillColorModal({ visible: false, initialColor: "transparent" })
          }
          onSelectColor={handleFillColorChange}
          initialColor={fillColorModal.initialColor}
        />
      </div>
    </div>
  );
};

export default Canvas;
