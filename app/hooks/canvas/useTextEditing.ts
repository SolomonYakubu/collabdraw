/**
 * Hook for handling text editing functionality
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { Shape, TextShape } from "../../types/shapes";

interface UseTextEditingProps {
  shapes: Shape[];
  setShapes: (shapes: Shape[] | ((prevShapes: Shape[]) => Shape[])) => void;
  selectedId: string | number | null;
  saveToHistory: () => void;
  onShapeUpdated?: (shape: Shape) => void;
  canvasRef?: React.RefObject<HTMLDivElement>;
}

export const useTextEditing = ({
  shapes,
  setShapes,
  selectedId,
  saveToHistory,
  onShapeUpdated,
}: UseTextEditingProps) => {
  const [editingId, setEditingId] = useState<string | number | null>(null);
  const initialTextRef = useRef<string>("");
  const isUpdatingRef = useRef<boolean>(false);
  const keyboardEventHandledRef = useRef<boolean>(false);

  // End text editing
  const endTextEditing = useCallback(() => {
    if (!editingId || isUpdatingRef.current) return;
    isUpdatingRef.current = true;

    const currentEditingId = editingId;
    setEditingId(null);

    // Update shape
    setShapes((prevShapes) => {
      const editedShape = prevShapes.find((s) => s.id === currentEditingId) as
        | TextShape
        | undefined;

      if (!editedShape) return prevShapes;

      const finalText = editedShape.text || "";
      const updatedShape = {
        ...editedShape,
        isEditing: false,
        cursorPosition: undefined,
        selection: undefined,
      };

      const updatedShapes = prevShapes.map((shape) =>
        shape.id === currentEditingId ? updatedShape : shape
      );

      // Handle external updates
      setTimeout(() => {
        if (onShapeUpdated) {
          onShapeUpdated(updatedShape);
        }

        // Only save to history if text actually changed
        if (finalText !== initialTextRef.current) {
          saveToHistory();
        }

        isUpdatingRef.current = false;
      }, 0);

      return updatedShapes;
    });
  }, [editingId, setShapes, onShapeUpdated, saveToHistory]);

  // Start text editing
  const startTextEditing = useCallback(
    (id: string | number) => {
      if (isUpdatingRef.current || editingId === id) return;
      isUpdatingRef.current = true;

      const shape = shapes.find((s) => s.id === id) as TextShape | undefined;
      if (!shape) {
        isUpdatingRef.current = false;
        return;
      }

      // Store initial text
      initialTextRef.current = shape.text || "";

      // Set initial cursor position at end of text
      const lines = shape.text?.split("\n") || [""];
      const lastLineIndex = lines.length - 1;
      const lastLineLength = lines[lastLineIndex].length;

      // Start editing in the state
      setEditingId(id);
      setShapes((prevShapes) =>
        prevShapes.map((s) =>
          s.id === id
            ? {
                ...s,
                isEditing: true,
                cursorPosition: {
                  line: lastLineIndex,
                  offset: lastLineLength,
                },
              }
            : s
        )
      );

      isUpdatingRef.current = false;
    },
    [shapes, editingId, setShapes]
  );

  // Handler for keyboard events during editing
  useEffect(() => {
    if (!editingId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (keyboardEventHandledRef.current) return;
      keyboardEventHandledRef.current = true;

      setShapes((prevShapes) => {
        const currentShape = prevShapes.find((s) => s.id === editingId) as
          | TextShape
          | undefined;

        if (!currentShape || !currentShape.isEditing) return prevShapes;

        // Make a copy of the text to modify
        let text = currentShape.text || "";
        const lines = text.split("\n");

        // Get cursor position
        const cursorPosition = currentShape.cursorPosition || {
          line: 0,
          offset: 0,
        };
        const { line, offset } = cursorPosition;

        // New cursor position to set after action
        let newPosition = { ...cursorPosition };
        let currentLine = lines[line] || "";

        // Handle different key presses
        switch (e.key) {
          case "Escape":
            // Cancel editing
            e.preventDefault();
            setTimeout(() => endTextEditing(), 0);
            return prevShapes;

          case "Enter":
            if (e.ctrlKey || e.metaKey) {
              // Finish editing with Ctrl/Cmd+Enter
              e.preventDefault();
              setTimeout(() => endTextEditing(), 0);
              return prevShapes;
            }

            // Insert new line
            e.preventDefault();
            lines.splice(line + 1, 0, currentLine.substring(offset));
            lines[line] = currentLine.substring(0, offset);
            text = lines.join("\n");

            // Move cursor to beginning of new line
            newPosition = { line: line + 1, offset: 0 };
            break;

          case "Backspace":
            e.preventDefault();
            if (offset > 0) {
              // Delete character before cursor
              lines[line] =
                currentLine.substring(0, offset - 1) +
                currentLine.substring(offset);
              newPosition = { line, offset: offset - 1 };
            } else if (line > 0) {
              // Join with previous line
              const previousLine = lines[line - 1];
              const newOffset = previousLine.length;
              lines[line - 1] = previousLine + currentLine;
              lines.splice(line, 1);
              newPosition = { line: line - 1, offset: newOffset };
            }
            text = lines.join("\n");
            break;

          case "Delete":
            e.preventDefault();
            if (offset < currentLine.length) {
              // Delete character after cursor
              lines[line] =
                currentLine.substring(0, offset) +
                currentLine.substring(offset + 1);
            } else if (line < lines.length - 1) {
              // Join with next line
              lines[line] = currentLine + lines[line + 1];
              lines.splice(line + 1, 1);
            }
            text = lines.join("\n");
            break;

          case "ArrowLeft":
            e.preventDefault();
            if (offset > 0) {
              newPosition = { line, offset: offset - 1 };
            } else if (line > 0) {
              newPosition = {
                line: line - 1,
                offset: lines[line - 1].length,
              };
            }
            break;

          case "ArrowRight":
            e.preventDefault();
            if (offset < currentLine.length) {
              newPosition = { line, offset: offset + 1 };
            } else if (line < lines.length - 1) {
              newPosition = { line: line + 1, offset: 0 };
            }
            break;

          case "ArrowUp":
            e.preventDefault();
            if (line > 0) {
              const targetLine = lines[line - 1];
              newPosition = {
                line: line - 1,
                offset: Math.min(offset, targetLine.length),
              };
            }
            break;

          case "ArrowDown":
            e.preventDefault();
            if (line < lines.length - 1) {
              const targetLine = lines[line + 1];
              newPosition = {
                line: line + 1,
                offset: Math.min(offset, targetLine.length),
              };
            }
            break;

          default:
            // Handle normal character input
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              lines[line] =
                currentLine.substring(0, offset) +
                e.key +
                currentLine.substring(offset);
              text = lines.join("\n");
              newPosition = { line, offset: offset + 1 };
            }
            break;
        }

        // Update the shape with new text and cursor position
        return prevShapes.map((s) =>
          s.id === editingId
            ? {
                ...s,
                text,
                cursorPosition: newPosition,
              }
            : s
        );
      });

      // Reset the handled flag after a small delay
      setTimeout(() => {
        keyboardEventHandledRef.current = false;
      }, 10);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [editingId, endTextEditing, setShapes]);

  // Handle clicks outside the editing shape
  useEffect(() => {
    if (!editingId) return;

    const handleClick = (e: MouseEvent) => {
      // We need more precise hit detection here based on where the text shape is
      // For now, end text editing on any click
      endTextEditing();
    };

    // Delay adding the listener to prevent immediate triggering
    const timeoutId = setTimeout(() => {
      window.addEventListener("mousedown", handleClick);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [editingId, endTextEditing]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      initialTextRef.current = "";
    };
  }, []);

  return {
    editingId,
    startTextEditing,
    endTextEditing,
  };
};
