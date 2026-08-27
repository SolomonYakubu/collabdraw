"use client";

import { useCallback, useRef } from "react";

import {
  type Shape,
  type ToolType,
} from "../../types/shapes";
import {
  duplicateElement,
  translateElement,
} from "../../services/canvas/elements";
import {
  MAX_BINDING_GAP_PX,
  settleBindingsAfterMove,
  updateBoundElements,
} from "../../services/canvas/bindings";
import { exportSceneToDataURL } from "../../services/canvas/renderer";
import type { ElementsUpdater } from "./useScene";

interface UseCanvasCommandsProps {
  elements: Shape[];
  elementsRef: React.MutableRefObject<Shape[]>;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  setTool: (tool: ToolType) => void;
  applyElements: (updater: ElementsUpdater, options?: { changedIds?: string[]; deletedIds?: string[]; broadcast?: "full" | "elements" }) => Shape[];
  viewportRef: React.MutableRefObject<{ zoom: number }>;
}

export const useCanvasCommands = ({
  elements,
  elementsRef,
  selectedIds,
  setSelectedIds,
  setTool,
  applyElements,
  viewportRef,
}: UseCanvasCommandsProps) => {
  const clipboardRef = useRef<Shape[]>([]);

  const deleteSelection = useCallback(() => {
    if (selectedIds.length === 0) return;

    const removing = new Set(selectedIds);
    for (const element of elementsRef.current) {
      if (!removing.has(element.id)) continue;
      for (const bound of element.boundElements ?? []) {
        if (bound.type === "text") removing.add(bound.id);
      }
    }

    applyElements(
      (previous) => previous.filter((element) => !removing.has(element.id)),
      { deletedIds: [...removing] },
    );
    setSelectedIds([]);
  }, [applyElements, elementsRef, selectedIds, setSelectedIds]);

  const duplicateSelection = useCallback(() => {
    if (selectedIds.length === 0) return;

    const wanted = new Set(selectedIds);
    const copies = elementsRef.current
      .filter((element) => wanted.has(element.id))
      .map((element) => duplicateElement(element));
    if (copies.length === 0) return;

    applyElements((previous) => [...previous, ...copies], {
      changedIds: copies.map((element) => element.id),
    });
    setSelectedIds(copies.map((element) => element.id));
  }, [applyElements, elementsRef, selectedIds, setSelectedIds]);

  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      if (selectedIds.length === 0) return;
      const moving = new Set(selectedIds);
      applyElements(
        (previous) =>
          settleBindingsAfterMove(
            previous.map((element) =>
              moving.has(element.id) ? translateElement(element, dx, dy) : element,
            ),
            moving,
            MAX_BINDING_GAP_PX / viewportRef.current.zoom,
          ),
        { changedIds: selectedIds },
      );
    },
    [applyElements, selectedIds, viewportRef],
  );

  const selectAll = useCallback(() => {
    setSelectedIds(elementsRef.current.map((element) => element.id));
    setTool("Select");
  }, [elementsRef, setSelectedIds, setTool]);

  const copySelection = useCallback(() => {
    const wanted = new Set(selectedIds);
    clipboardRef.current = elementsRef.current
      .filter((element) => wanted.has(element.id))
      .map((element) => ({ ...element }));
  }, [elementsRef, selectedIds]);

  const cutSelection = useCallback(() => {
    copySelection();
    deleteSelection();
  }, [copySelection, deleteSelection]);

  const paste = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    const copies = clipboardRef.current.map((element) => duplicateElement(element, 20));
    applyElements((previous) => [...previous, ...copies], {
      changedIds: copies.map((element) => element.id),
    });
    setSelectedIds(copies.map((element) => element.id));
    setTool("Select");
  }, [applyElements, setSelectedIds, setTool]);

  const reorderSelection = useCallback(
    (mode: "front" | "back" | "forward" | "backward") => {
      if (selectedIds.length === 0) return;
      const wanted = new Set(selectedIds);

      applyElements((previous) => {
        const moving = previous.filter((element) => wanted.has(element.id));
        const rest = previous.filter((element) => !wanted.has(element.id));
        if (mode === "front") return [...rest, ...moving];
        if (mode === "back") return [...moving, ...rest];

        const next = [...previous];
        const indices = next
          .map((element, index) => ({ element, index }))
          .filter(({ element }) => wanted.has(element.id))
          .map(({ index }) => index);
        if (mode === "forward") {
          for (let index = indices.length - 1; index >= 0; index -= 1) {
            const current = indices[index];
            if (current < next.length - 1 && !wanted.has(next[current + 1].id)) {
              [next[current], next[current + 1]] = [next[current + 1], next[current]];
            }
          }
        } else {
          for (let index = 0; index < indices.length; index += 1) {
            const current = indices[index];
            if (current > 0 && !wanted.has(next[current - 1].id)) {
              [next[current], next[current - 1]] = [next[current - 1], next[current]];
            }
          }
        }
        return next;
      }, { broadcast: "full" });
    },
    [applyElements, selectedIds],
  );

  const clearCanvas = useCallback(() => {
    if (elementsRef.current.length === 0) return;
    applyElements(() => [], { broadcast: "full" });
    setSelectedIds([]);
  }, [applyElements, elementsRef, setSelectedIds]);

  const exportPNG = useCallback(() => {
    const dataURL = exportSceneToDataURL(elementsRef.current);
    if (!dataURL) return;
    const link = document.createElement("a");
    link.download = `collabdraw-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = dataURL;
    link.click();
  }, [elementsRef]);

  return {
    clipboardRef,
    clearCanvas,
    copySelection,
    cutSelection,
    deleteSelection,
    duplicateSelection,
    exportPNG,
    nudgeSelection,
    paste,
    reorderSelection,
    selectAll,
  };
};