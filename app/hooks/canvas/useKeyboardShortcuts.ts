"use client";

/**
 * Keyboard shortcuts, matching Excalidraw's bindings.
 *
 * Attached once at the window level. Anything typed into an input, textarea or
 * contenteditable is ignored so the text editor keeps its keys.
 */
import { useEffect, useRef } from "react";
import type { ToolType } from "../../types/shapes";

/** Letter and digit shortcuts for each tool, as in Excalidraw. */
export const TOOL_SHORTCUTS: Array<{ tool: ToolType; keys: string[]; label: string }> = [
  { tool: "Select", keys: ["v", "1"], label: "V" },
  { tool: "Pan", keys: ["h"], label: "H" },
  { tool: "Square", keys: ["r", "2"], label: "R" },
  { tool: "Diamond", keys: ["d", "3"], label: "D" },
  { tool: "Triangle", keys: ["g", "9"], label: "G" },
  { tool: "Circle", keys: ["o", "4"], label: "O" },
  { tool: "Arrow", keys: ["a", "5"], label: "A" },
  { tool: "Line", keys: ["l", "6"], label: "L" },
  { tool: "Freehand", keys: ["p", "7"], label: "P" },
  { tool: "Text", keys: ["t", "8"], label: "T" },
  { tool: "Eraser", keys: ["e", "0"], label: "E" },
];

const TOOL_BY_KEY = new Map<string, ToolType>();
for (const { tool, keys } of TOOL_SHORTCUTS) {
  for (const key of keys) {
    TOOL_BY_KEY.set(key, tool);
  }
}

export interface KeyboardCallbacks {
  setTool: (tool: ToolType) => void;
  toggleToolLock: () => void;
  undo: () => void;
  redo: () => void;
  deleteSelection: () => void;
  selectAll: () => void;
  duplicateSelection: () => void;
  nudgeSelection: (dx: number, dy: number) => void;
  copySelection: () => void;
  cutSelection: () => void;
  paste: () => void;
  bringForward: () => void;
  sendBackward: () => void;
  bringToFront: () => void;
  sendToBack: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  zoomToFit: () => void;
  escape: () => void;
  /** True while a text editor is open, which suppresses everything else. */
  isEditingText: () => boolean;
}

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
};

export const useKeyboardShortcuts = (
  callbacks: KeyboardCallbacks,
  spacePressedRef: React.MutableRefObject<boolean>,
): void => {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const api = callbacksRef.current;

      if (event.key === " " && !isTypingTarget(event.target)) {
        // Hold space to pan; also stop the page scrolling underneath.
        spacePressedRef.current = true;
        event.preventDefault();
        return;
      }

      if (isTypingTarget(event.target) || api.isEditingText()) {
        return;
      }

      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (event.key === "Escape") {
        event.preventDefault();
        api.escape();
        return;
      }

      if (mod) {
        switch (key) {
          case "z":
            event.preventDefault();
            if (event.shiftKey) {
              api.redo();
            } else {
              api.undo();
            }
            return;
          case "y":
            event.preventDefault();
            api.redo();
            return;
          case "a":
            event.preventDefault();
            api.selectAll();
            return;
          case "d":
            event.preventDefault();
            api.duplicateSelection();
            return;
          case "c":
            api.copySelection();
            return;
          case "x":
            api.cutSelection();
            return;
          case "v":
            api.paste();
            return;
          case "]":
            event.preventDefault();
            if (event.shiftKey) {
              api.bringToFront();
            } else {
              api.bringForward();
            }
            return;
          case "[":
            event.preventDefault();
            if (event.shiftKey) {
              api.sendToBack();
            } else {
              api.sendBackward();
            }
            return;
          case "=":
          case "+":
            event.preventDefault();
            api.zoomIn();
            return;
          case "-":
            event.preventDefault();
            api.zoomOut();
            return;
          case "0":
            event.preventDefault();
            api.resetZoom();
            return;
          default:
            return;
        }
      }

      if (event.shiftKey && event.key === "!") {
        // Shift+1 on most layouts.
        event.preventDefault();
        api.zoomToFit();
        return;
      }

      switch (event.key) {
        case "Delete":
        case "Backspace":
          event.preventDefault();
          api.deleteSelection();
          return;
        case "ArrowUp":
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight": {
          event.preventDefault();
          const step = event.shiftKey ? 20 : 1;
          const dx =
            event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
          const dy =
            event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
          api.nudgeSelection(dx, dy);
          return;
        }
        default:
          break;
      }

      if (event.shiftKey) {
        return;
      }

      if (key === "q") {
        event.preventDefault();
        api.toggleToolLock();
        return;
      }

      const tool = TOOL_BY_KEY.get(key);
      if (tool) {
        event.preventDefault();
        api.setTool(tool);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") {
        spacePressedRef.current = false;
      }
    };

    // Losing focus mid-pan would otherwise leave space "stuck" down.
    const onBlur = () => {
      spacePressedRef.current = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [spacePressedRef]);
};
