/**
 * Service for managing canvas history (undo/redo functionality)
 */

import { Shape } from "../../types/shapes";

// Maximum history size to prevent memory issues
const MAX_HISTORY_SIZE = 50;
interface HistoryEntry {
  shapes: Shape[];
  timestamp: number;
}
/**
 * Create a new history entry
 */
export const createHistoryEntry = (shapes: Shape[]): HistoryEntry => {
  return {
    shapes: [...shapes],
    timestamp: Date.now(),
  };
};

/**
 * Add a new entry to history, respecting max size
 */
export const addHistoryEntry = (
  history: HistoryEntry[],
  currentIndex: number,
  newEntry: HistoryEntry
): { history: HistoryEntry[]; historyIndex: number } => {
  // Remove any future states if we're in the middle of the history
  const newHistory = history.slice(0, currentIndex + 1);

  // Add the new state
  newHistory.push(newEntry);

  // Trim history if it gets too large
  if (newHistory.length > MAX_HISTORY_SIZE) {
    newHistory.shift();
  }

  return {
    history: newHistory,
    historyIndex: newHistory.length - 1,
  };
};

/**
 * Initialize history with an empty canvas state
 */
export const initializeHistory = (): {
  history: HistoryEntry[];
  historyIndex: number;
} => {
  const emptyEntry = createHistoryEntry([]);
  return {
    history: [emptyEntry],
    historyIndex: 0,
  };
};

/**
 * Save current canvas state to history
 */
export const saveToHistory = (
  shapes: Shape[],
  history: HistoryEntry[],
  historyIndex: number
): { history: HistoryEntry[]; historyIndex: number } | null => {
  try {
    // Create a new history entry
    const entry = createHistoryEntry(shapes);

    // Only save if different from last state
    if (historyIndex >= 0) {
      const lastEntry = history[historyIndex];
      if (
        lastEntry &&
        lastEntry.shapes.length === shapes.length &&
        JSON.stringify(lastEntry.shapes) === JSON.stringify(shapes)
      ) {
        return null;
      }
    }

    return addHistoryEntry(history, historyIndex, entry);
  } catch (error) {
    console.error("Error saving history:", error);
    return null;
  }
};

/**
 * Perform an undo operation
 */
export const undo = (
  history: HistoryEntry[],
  historyIndex: number
): { newIndex: number; shapes: Shape[] } | null => {
  if (historyIndex <= 0) {
    return null;
  }

  try {
    const newIndex = historyIndex - 1;
    const entry = history[newIndex];

    return {
      newIndex,
      shapes: [...entry.shapes],
    };
  } catch (error) {
    console.error("Error performing undo:", error);
    return null;
  }
};

/**
 * Perform a redo operation
 */
export const redo = (
  history: HistoryEntry[],
  historyIndex: number
): { newIndex: number; shapes: Shape[] } | null => {
  if (historyIndex >= history.length - 1) {
    return null;
  }

  try {
    const newIndex = historyIndex + 1;
    const entry = history[newIndex];

    return {
      newIndex,
      shapes: [...entry.shapes],
    };
  } catch (error) {
    console.error("Error performing redo:", error);
    return null;
  }
};
