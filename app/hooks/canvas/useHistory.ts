/**
 * Hook for managing drawing history (undo/redo)
 */
import { useState, useCallback, useEffect, RefObject } from "react";
import { Shape } from "../../types/shapes";
import { Socket } from "socket.io-client";

interface UseHistoryProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  shapes: Shape[];
  setShapes: (shapes: Shape[]) => void;
  selectedId: string | number | null;
  socket?: Socket | null;
  onShapeUpdated?: (shape: Shape) => void;
}

export const useHistory = ({
  canvasRef,
  shapes,
  setShapes,
  selectedId,
  socket,
  onShapeUpdated,
}: UseHistoryProps) => {
  // History stacks for undo/redo
  const [history, setHistory] = useState<Shape[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Save shapes to history
  const saveToHistory = useCallback(() => {
    setHistory((prevHistory) => {
      const newHistory = [
        ...prevHistory.slice(0, historyIndex + 1),
        [...shapes],
      ];
      // Limit history size to prevent memory issues
      return newHistory.slice(Math.max(0, newHistory.length - 50));
    });

    setHistoryIndex((prevIndex) => {
      // If we undo and then draw something new, we need to remove redo stack
      const newIndex = Math.min(prevIndex + 1, history.length);
      return newIndex;
    });
  }, [shapes, history, historyIndex]);

  // Update undo/redo availability whenever history changes
  useEffect(() => {
    setCanUndo(historyIndex > 0);
    setCanRedo(historyIndex < history.length - 1);
  }, [history, historyIndex]);

  // Undo last action
  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      const previousState = history[newIndex];
      setHistoryIndex(newIndex);
      setShapes(previousState);

      // For collaboration, broadcast the entire canvas after undo
      if (socket?.connected) {
        socket.emit("canvas-data", {
          roomId: socket.io.opts.query?.roomId,
          userId: socket.io.opts.query?.userId,
          shapes: previousState,
        });
      }
    }
  }, [history, historyIndex, setShapes, socket]);

  // Redo last undone action
  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      const nextState = history[newIndex];
      setHistoryIndex(newIndex);
      setShapes(nextState);

      // For collaboration, broadcast the entire canvas after redo
      if (socket?.connected) {
        socket.emit("canvas-data", {
          roomId: socket.io.opts.query?.roomId,
          userId: socket.io.opts.query?.userId,
          shapes: nextState,
        });
      }
    }
  }, [history, historyIndex, setShapes, socket]);

  // Clear canvas
  const clear = useCallback(() => {
    // Save current state to history before clearing
    if (shapes.length > 0) {
      saveToHistory();
    }

    // Clear shapes
    setShapes([]);

    // For collaboration, broadcast the cleared canvas
    if (socket?.connected) {
      socket.emit("canvas-data", {
        roomId: socket.io.opts.query?.roomId,
        userId: socket.io.opts.query?.userId,
        shapes: [],
      });
    }
  }, [shapes, saveToHistory, setShapes, socket]);

  // Save initial state to history
  useEffect(() => {
    if (history.length === 0 && shapes.length > 0) {
      setHistory([[...shapes]]);
      setHistoryIndex(0);
    }
  }, [shapes, history.length]);

  return {
    saveToHistory,
    undo,
    redo,
    clear,
    canUndo,
    canRedo,
  };
};
