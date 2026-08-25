"use client";

/**
 * The editor.
 *
 * This component wires the pieces together and owns only genuinely local UI
 * state (active tool, selection, panels). Scene data lives in `useScene`,
 * input in `usePointerInteraction`, drawing in the renderer — previously all
 * three were tangled through 1,300 lines here and in `RoughCanvas`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_STYLE,
  isLinearShape,
  type ElementStyle,
  type Point,
  type Shape,
  type ToolType,
} from "../types/shapes";
import {
  duplicateElement,
  getElementBounds,
  mutateElement,
  translateElement,
} from "../services/canvas/elements";
import {
  MAX_BINDING_GAP_PX,
  removeStaleBindings,
  settleBindingsAfterMove,
  updateBoundElements,
} from "../services/canvas/bindings";
import { getSelectionBounds } from "../services/canvas/transform";
import {
  getElementAtPoint,
  HIT_THRESHOLD_PX,
} from "../services/canvas/hitTest";
import { exportSceneToDataURL } from "../services/canvas/renderer";
import { unionBoxes } from "../utils/geometry";
import { clientToWorld, screenToWorld } from "../utils/viewport";

import { useScene, type SceneBroadcast } from "../hooks/canvas/useScene";
import { useViewport } from "../hooks/canvas/useViewport";
import { usePointerInteraction } from "../hooks/canvas/usePointerInteraction";
import { useTextEditor } from "../hooks/canvas/useTextEditor";
import { useKeyboardShortcuts } from "../hooks/canvas/useKeyboardShortcuts";
import { useAIAssistant } from "../hooks/canvas/useAIAssistant";
import { useTheme } from "../hooks/useTheme";
import { useCollaborationContext } from "../context/CollaborationContext";

import CanvasSurface from "./canvas/CanvasSurface";
import TextEditorOverlay from "./canvas/TextEditorOverlay";
import RemoteCursors from "./canvas/RemoteCursors";
import Toolbar from "./canvas/ui/Toolbar";
import StylePanel from "./canvas/ui/StylePanel";
import ContextMenu, { type ContextMenuItem } from "./canvas/ui/ContextMenu";
import AIAgentPanel from "./canvas/AIAgentPanel";
import ZoomControls from "./canvas/ui/ZoomControls";

interface CanvasProps {
  initialTool?: ToolType;
  isCollaborative?: boolean;
}

/** Tools whose elements can take a background fill. */
const FILLABLE_TOOLS = new Set<ToolType>([
  "Square",
  "Circle",
  "Diamond",
  "Triangle",
]);

/** Tools whose elements have an arrow shape. */
const LINEAR_TOOLS = new Set<ToolType>(["Line", "Arrow"]);

const Canvas: React.FC<CanvasProps> = ({
  initialTool = "Select",
  isCollaborative = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const interactiveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const spacePressedRef = useRef(false);
  const clipboardRef = useRef<Shape[]>([]);

  const [tool, setTool] = useState<ToolType>(initialTool);
  /*
   * The chosen tool stays chosen until another is picked. Excalidraw's default is
   * to snap back to selection after each shape, which is a surprise when you are
   * drawing several of the same thing; the lock can still be turned off with Q.
   */
  const [toolLocked, setToolLocked] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [style, setStyle] = useState<ElementStyle>(DEFAULT_STYLE);
  const [showUsers, setShowUsers] = useState(false);
  const [isAIPanelOpen, setIsAIPanelOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<Point | null>(null);

  const { preference: themePreference, theme, cycle: cycleTheme } = useTheme();

  // Dark mode inverts the element layer rather than re-rendering it; the text
  // editor overlay has to match, or text would jump colour when editing starts.
  const canvasFilter =
    theme === "dark" ? "invert(93%) hue-rotate(180deg)" : "none";

  const collaboration = useCollaborationContext();
  const {
    isConnected,
    users,
    cursors,
    remoteInProgress,
    linkCopied,
    copyShareableLink,
    sendCursor,
    sendScene,
    sendElements,
    sendDeletions,
    sendPendingElement,
    setEventHandlers,
    userId,
    roomId,
  } = collaboration;

  /* ------------------------------------------------------------------ *
   * Scene
   * ------------------------------------------------------------------ */

  /**
   * Assigned to `ai.notifyUserEdit` once the assistant exists. A ref breaks the
   * construction-order cycle: `useScene` is created (and its `onChange` bound)
   * before `useAIAssistant`, which itself needs `applyElements` from `useScene`.
   */
  const notifyEditRef = useRef<() => void>(() => {});

  const handleSceneChange = useCallback(
    ({ elements, changed, deletedIds, mode }: SceneBroadcast) => {
      // A locally-originated change is the user taking their turn. `onChange`
      // never fires for remote peers' edits (they apply with broadcast:"none"),
      // and the assistant hook filters out its own writes, so this can fire
      // unconditionally — including offline, which the collaboration send below
      // skips.
      notifyEditRef.current();

      if (!isCollaborative) {
        return;
      }

      if (mode === "full") {
        sendScene(elements);
      } else if (changed.length > 0) {
        sendElements(changed);
      }

      if (deletedIds.length > 0) {
        sendDeletions(deletedIds);
      }
    },
    [isCollaborative, sendDeletions, sendElements, sendScene],
  );

  const scene = useScene({ onChange: handleSceneChange });
  const {
    elements,
    elementsRef,
    applyElements,
    commit,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory,
  } = scene;

  const viewportApi = useViewport(containerRef);
  const {
    viewport,
    viewportRef,
    setViewport,
    size,
    devicePixelRatio,
    zoomIn,
    zoomOut,
    resetZoom,
    zoomToFit,
  } = viewportApi;

  /* ------------------------------------------------------------------ *
   * Collaboration wiring
   * ------------------------------------------------------------------ */

  useEffect(() => {
    if (!isCollaborative) {
      return;
    }

    setEventHandlers({
      // A full scene sync (joining a room, or a peer's undo/clear) becomes the
      // new history baseline. Resetting it here rather than from an effect that
      // watched `elements` matters: that effect also fired on the very first
      // shape the user drew locally, which discarded the empty state and made
      // that first shape impossible to undo.
      onScene: (incoming) => resetHistory(removeStaleBindings(incoming)),
      onElements: (incoming) => {
        // Remote edits are authoritative for the elements they mention and are
        // never pushed back onto the wire, which is what caused the previous
        // update storms.
        applyElements(
          (previous) => {
            const byId = new Map(previous.map((element) => [element.id, element]));
            for (const element of incoming) {
              byId.set(element.id, element);
            }
            return [...byId.values()];
          },
          { commit: false, broadcast: "none" },
        );
      },
      onDeletions: (ids) => {
        const removing = new Set(ids);
        applyElements(
          (previous) =>
            removeStaleBindings(
              previous.filter((element) => !removing.has(element.id)),
            ),
          { commit: false, broadcast: "none" },
        );
        setSelectedIds((current) => current.filter((id) => !removing.has(id)));
      },
      getScene: () => elementsRef.current,
    });
  }, [applyElements, elementsRef, isCollaborative, resetHistory, setEventHandlers]);

  /* ------------------------------------------------------------------ *
   * Derived state
   * ------------------------------------------------------------------ */

  const selectedElements = useMemo(() => {
    if (selectedIds.length === 0) {
      return [];
    }
    const wanted = new Set(selectedIds);
    return elements.filter((element) => wanted.has(element.id));
  }, [elements, selectedIds]);

  const selectionBounds = useMemo(
    () => getSelectionBounds(selectedElements),
    [selectedElements],
  );

  /* Prune ids that no longer exist (deleted locally or by a collaborator). */
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.length === 0) {
        return current;
      }
      const live = new Set(elements.map((element) => element.id));
      const next = current.filter((id) => live.has(id));
      return next.length === current.length ? current : next;
    });
  }, [elements]);

  const textEditor = useTextEditor({
    elementsRef,
    applyElements,
    style,
    setSelectedIds,
  });

  const interaction = usePointerInteraction({
    canvasRef: interactiveCanvasRef,
    elementsRef,
    applyElements,
    viewportRef,
    setViewport,
    tool,
    setTool,
    toolLocked,
    style,
    selectedIds,
    setSelectedIds,
    spacePressedRef,
    onEditText: textEditor.startEditing,
    onCreateText: textEditor.createAndEdit,
    onPendingElementChange: isCollaborative ? sendPendingElement : undefined,
  });

  /** Elements to paint: the scene, remote work in progress, minus the element
   *  currently open in the text editor (the textarea shows that one). */
  const renderedElements = useMemo(() => {
    const editingId = textEditor.editingId;
    const base = editingId
      ? elements.filter((element) => element.id !== editingId)
      : elements;

    const remote = Object.values(remoteInProgress).filter(
      (element) => !base.some((existing) => existing.id === element.id),
    );

    return remote.length > 0 ? [...base, ...remote] : base;
  }, [elements, remoteInProgress, textEditor.editingId]);

  const bindingHighlightElement = useMemo(() => {
    const id = interaction.visuals.bindingHighlightId;
    return id ? elements.find((element) => element.id === id) ?? null : null;
  }, [elements, interaction.visuals.bindingHighlightId]);

  /* ------------------------------------------------------------------ *
   * Commands
   * ------------------------------------------------------------------ */

  const deleteSelection = useCallback(() => {
    if (selectedIds.length === 0) {
      return;
    }

    const removing = new Set(selectedIds);
    // Deleting a container removes the label bound to it as well.
    for (const element of elementsRef.current) {
      if (!removing.has(element.id)) {
        continue;
      }
      for (const bound of element.boundElements ?? []) {
        if (bound.type === "text") {
          removing.add(bound.id);
        }
      }
    }

    applyElements(
      (previous) => previous.filter((element) => !removing.has(element.id)),
      { deletedIds: [...removing] },
    );
    setSelectedIds([]);
  }, [applyElements, elementsRef, selectedIds]);

  const duplicateSelection = useCallback(() => {
    if (selectedIds.length === 0) {
      return;
    }

    const wanted = new Set(selectedIds);
    const copies = elementsRef.current
      .filter((element) => wanted.has(element.id))
      .map((element) => duplicateElement(element));

    if (copies.length === 0) {
      return;
    }

    applyElements((previous) => [...previous, ...copies], {
      changedIds: copies.map((element) => element.id),
    });
    setSelectedIds(copies.map((element) => element.id));
  }, [applyElements, elementsRef, selectedIds]);

  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      if (selectedIds.length === 0) {
        return;
      }

      const moving = new Set(selectedIds);

      applyElements(
        (previous) =>
          settleBindingsAfterMove(
            previous.map((element) =>
              moving.has(element.id)
                ? translateElement(element, dx, dy)
                : element,
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
  }, [elementsRef]);

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
    const copied = clipboardRef.current;
    if (copied.length === 0) {
      return;
    }

    const copies = copied.map((element) => duplicateElement(element, 20));
    applyElements((previous) => [...previous, ...copies], {
      changedIds: copies.map((element) => element.id),
    });
    setSelectedIds(copies.map((element) => element.id));
    setTool("Select");
  }, [applyElements]);

  /** Reorder the selection within the element array, which is the z-order. */
  const reorderSelection = useCallback(
    (mode: "front" | "back" | "forward" | "backward") => {
      if (selectedIds.length === 0) {
        return;
      }

      const wanted = new Set(selectedIds);

      applyElements(
        (previous) => {
          const moving = previous.filter((element) => wanted.has(element.id));
          const rest = previous.filter((element) => !wanted.has(element.id));

          if (mode === "front") {
            return [...rest, ...moving];
          }
          if (mode === "back") {
            return [...moving, ...rest];
          }

          // One step at a time, preserving relative order within the selection.
          const next = [...previous];
          const indices = next
            .map((element, index) => ({ element, index }))
            .filter(({ element }) => wanted.has(element.id))
            .map(({ index }) => index);

          if (mode === "forward") {
            for (let i = indices.length - 1; i >= 0; i -= 1) {
              const index = indices[i];
              if (index < next.length - 1 && !wanted.has(next[index + 1].id)) {
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
              }
            }
          } else {
            for (let i = 0; i < indices.length; i += 1) {
              const index = indices[i];
              if (index > 0 && !wanted.has(next[index - 1].id)) {
                [next[index], next[index - 1]] = [next[index - 1], next[index]];
              }
            }
          }

          return next;
        },
        // Ordering is positional, so peers need the whole array.
        { broadcast: "full" },
      );
    },
    [applyElements, selectedIds],
  );

  const clearCanvas = useCallback(() => {
    if (elementsRef.current.length === 0) {
      return;
    }
    applyElements(() => [], { broadcast: "full" });
    setSelectedIds([]);
  }, [applyElements, elementsRef]);

  const exportPNG = useCallback(() => {
    const dataURL = exportSceneToDataURL(elementsRef.current);

    if (!dataURL) {
      return;
    }

    const link = document.createElement("a");
    link.download = `collabdraw-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = dataURL;
    link.click();
  }, [elementsRef]);

  /** Apply a style change to the selection, and remember it for new elements. */
  const handleStyleChange = useCallback(
    (patch: Partial<ElementStyle>) => {
      setStyle((current) => ({ ...current, ...patch }));

      if (selectedIds.length === 0) {
        return;
      }

      const wanted = new Set(selectedIds);
      const { fontSize, fontFamily, ...elementPatch } = patch;

      applyElements(
        (previous) => {
          const restyled = previous.map((element) => {
            if (!wanted.has(element.id)) {
              return element;
            }

            const updates: Partial<Shape> = { ...elementPatch };

            // A fill on text or a line would never be visible; skip it.
            if (
              (element.tool === "Text" ||
                element.tool === "Freehand" ||
                isLinearShape(element)) &&
              "fill" in updates
            ) {
              delete updates.fill;
            }

            if (element.tool === "Text") {
              if (fontSize !== undefined) {
                Object.assign(updates, { fontSize });
              }
              if (fontFamily !== undefined) {
                Object.assign(updates, { fontFamily });
              }
            }

            return mutateElement(element, updates);
          });

          // Changing the arrow shape changes the path, so the affected
          // connectors need re-resolving against their bindings.
          return patch.edgeStyle
            ? updateBoundElements(restyled, wanted)
            : restyled;
        },
        { changedIds: selectedIds },
      );
    },
    [applyElements, selectedIds],
  );

  const handleToolChange = useCallback(
    (next: ToolType) => {
      textEditor.stopEditing();
      interaction.cancel();

      if (next !== "Select") {
        setSelectedIds([]);
      }

      setTool(next);
    },
    [interaction, textEditor],
  );

  const handleEscape = useCallback(() => {
    if (textEditor.editingId) {
      textEditor.stopEditing();
      return;
    }

    interaction.cancel();

    if (selectedIds.length > 0) {
      setSelectedIds([]);
      return;
    }

    if (tool !== "Select") {
      setTool("Select");
    }
  }, [interaction, selectedIds.length, textEditor, tool]);

  const sceneBounds = useMemo(
    () => unionBoxes(elements.map(getElementBounds)),
    [elements],
  );

  useKeyboardShortcuts(
    {
      setTool: handleToolChange,
      toggleToolLock: () => setToolLocked((locked) => !locked),
      undo,
      redo,
      deleteSelection,
      selectAll,
      duplicateSelection,
      nudgeSelection,
      copySelection,
      cutSelection,
      paste,
      bringForward: () => reorderSelection("forward"),
      sendBackward: () => reorderSelection("backward"),
      bringToFront: () => reorderSelection("front"),
      sendToBack: () => reorderSelection("back"),
      zoomIn,
      zoomOut,
      resetZoom,
      zoomToFit: () =>
        zoomToFit(
          selectionBounds ?? sceneBounds,
        ),
      escape: handleEscape,
      isEditingText: () => textEditor.editingId !== null,
    },
    spacePressedRef,
  );

  /* ------------------------------------------------------------------ *
   * Pointer plumbing
   * ------------------------------------------------------------------ */

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      interaction.handlers.onPointerMove(event);

      if (isCollaborative) {
        const canvas = interactiveCanvasRef.current;
        if (canvas) {
          // Cursors travel in world coordinates so they land on the same part
          // of the drawing whatever each peer's zoom and scroll happen to be.
          sendCursor(
            clientToWorld(
              event.clientX,
              event.clientY,
              canvas.getBoundingClientRect(),
              viewportRef.current,
            ),
          );
        }
      }
    },
    [interaction.handlers, isCollaborative, sendCursor, viewportRef],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      event.preventDefault();

      const container = containerRef.current;
      const canvas = interactiveCanvasRef.current;
      if (!container || !canvas) {
        return;
      }

      // Right-clicking an unselected element selects it first, so the menu's
      // actions apply to what the user actually pointed at.
      const world = clientToWorld(
        event.clientX,
        event.clientY,
        canvas.getBoundingClientRect(),
        viewportRef.current,
      );
      const hit = getElementAtPoint(
        world,
        elementsRef.current,
        HIT_THRESHOLD_PX / viewportRef.current.zoom,
      );

      if (hit) {
        setSelectedIds((current) =>
          current.includes(hit.id) ? current : [hit.id],
        );
      } else {
        setSelectedIds([]);
      }

      const rect = container.getBoundingClientRect();
      setContextMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    },
    [elementsRef, viewportRef],
  );

  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    const hasSelection = selectedIds.length > 0;

    return [
      {
        label: "Select all",
        shortcut: "Ctrl+A",
        onSelect: selectAll,
        disabled: elements.length === 0,
      },
      {
        label: "Paste",
        shortcut: "Ctrl+V",
        onSelect: paste,
        disabled: clipboardRef.current.length === 0,
      },
      {
        label: "Copy",
        shortcut: "Ctrl+C",
        onSelect: copySelection,
        disabled: !hasSelection,
        separatorBefore: true,
      },
      {
        label: "Duplicate",
        shortcut: "Ctrl+D",
        onSelect: duplicateSelection,
        disabled: !hasSelection,
      },
      {
        label: "Bring to front",
        shortcut: "Ctrl+Shift+]",
        onSelect: () => reorderSelection("front"),
        disabled: !hasSelection,
        separatorBefore: true,
      },
      {
        label: "Send to back",
        shortcut: "Ctrl+Shift+[",
        onSelect: () => reorderSelection("back"),
        disabled: !hasSelection,
      },
      {
        label: "Delete",
        shortcut: "Del",
        onSelect: deleteSelection,
        disabled: !hasSelection,
        danger: true,
        separatorBefore: true,
      },
    ];
  }, [
    copySelection,
    deleteSelection,
    duplicateSelection,
    elements.length,
    paste,
    reorderSelection,
    selectAll,
    selectedIds.length,
  ]);

  /* ------------------------------------------------------------------ *
   * AI
   * ------------------------------------------------------------------ */

  const ai = useAIAssistant({
    elementsRef,
    applyElements,
    commit,
    style,
    roomId,
    getViewportCenter: () =>
      screenToWorld(size.width / 2, size.height / 2, viewportRef.current),
    // Bring a freshly generated diagram into view, and select it so it can be
    // moved straight away.
    onDiagramPlaced: (bounds) => {
      zoomToFit(bounds);
      setSelectedIds([]);
    },
  });

  // Now that the assistant exists, let scene changes reach it (see notifyEditRef).
  notifyEditRef.current = ai.notifyUserEdit;

  const openAIPanel = useCallback(() => {
    setIsAIPanelOpen((open) => !open);
  }, []);

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */

  const showFillControls =
    selectedElements.length > 0
      ? selectedElements.some((element) => FILLABLE_TOOLS.has(element.tool))
      : FILLABLE_TOOLS.has(tool);

  const showEdgeStyleControls =
    selectedElements.length > 0
      ? selectedElements.some((element) => isLinearShape(element))
      : LINEAR_TOOLS.has(tool);

  const showStylePanel = selectedElements.length > 0 || tool !== "Select";

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ background: "var(--canvas-bg)" }}
    >
      <div ref={containerRef} className="absolute inset-0">
        <CanvasSurface
          size={size}
          devicePixelRatio={devicePixelRatio}
          viewport={viewport}
          elements={renderedElements}
          pendingElement={interaction.pendingElement}
          erasingIds={interaction.visuals.erasingIds}
          selectedElements={selectedElements}
          selectionBounds={textEditor.editingId ? null : selectionBounds}
          showHandles={!interaction.visuals.marquee}
          isTransforming={interaction.visuals.isTransforming}
          marquee={interaction.visuals.marquee}
          bindingHighlightElement={bindingHighlightElement}
          alignmentGuides={interaction.visuals.guides}
          eraserTrail={interaction.visuals.eraserTrail}
          activeHandle={interaction.visuals.activeHandle}
          snapPoint={interaction.visuals.snapPoint}
          cursor={interaction.cursor}
          canvasFilter={canvasFilter}
          interactiveCanvasRef={interactiveCanvasRef}
          onPointerDown={interaction.handlers.onPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={interaction.handlers.onPointerUp}
          onPointerCancel={interaction.handlers.onPointerCancel}
          onDoubleClick={interaction.handlers.onDoubleClick}
          onContextMenu={handleContextMenu}
        />

        {isCollaborative && (
          <RemoteCursors
            cursors={cursors}
            currentUserId={userId}
            viewport={viewport}
          />
        )}

        {textEditor.editingElement && (
          <TextEditorOverlay
            element={textEditor.editingElement}
            viewport={viewport}
            canvasFilter={canvasFilter}
            onChange={textEditor.updateText}
            onFinish={textEditor.stopEditing}
          />
        )}

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenuItems}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>

      {/* Top-centre tool island */}
      <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2">
        <Toolbar
          tool={tool}
          onToolChange={handleToolChange}
          toolLocked={toolLocked}
          onToggleToolLock={() => setToolLocked((locked) => !locked)}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
          onClear={clearCanvas}
          onExport={exportPNG}
          onShare={isCollaborative ? copyShareableLink : undefined}
          linkCopied={linkCopied}
          onToggleUsers={isCollaborative ? () => setShowUsers((s) => !s) : undefined}
          userCount={users.length}
          onToggleAI={openAIPanel}
          isAIPanelOpen={isAIPanelOpen}
          isAiGenerating={ai.isGenerating}
          aiConversationCount={ai.history.length}
          themePreference={themePreference}
          onCycleTheme={cycleTheme}
        />
      </div>

      {/* Left properties panel */}
      {showStylePanel && (
        <div className="pointer-events-none absolute left-3 top-20 z-30 max-h-[calc(100%-6rem)] overflow-y-auto">
          <StylePanel
            style={style}
            onStyleChange={handleStyleChange}
            hasSelection={selectedElements.length > 0}
            showFill={showFillControls}
            showEdgeStyle={showEdgeStyleControls}
            onDelete={deleteSelection}
            onDuplicate={duplicateSelection}
            onBringToFront={() => reorderSelection("front")}
            onSendToBack={() => reorderSelection("back")}
          />
        </div>
      )}

      <div className="absolute bottom-3 left-3 z-30 flex items-center gap-2">
        <ZoomControls
          zoom={viewport.zoom}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onReset={resetZoom}
          onZoomToFit={() => zoomToFit(selectionBounds ?? sceneBounds)}
        />

        {isCollaborative && (
          <div
            className="island flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium"
            style={{
              color: isConnected ? "var(--success)" : "var(--text-faint)",
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: isConnected
                  ? "var(--success)"
                  : "var(--text-faint)",
              }}
            />
            {isConnected ? "Live" : "Offline"}
          </div>
        )}
      </div>

      {isCollaborative && showUsers && users.length > 0 && (
        <div className="island absolute bottom-14 left-3 z-30 w-52 p-3">
          <p
            className="mb-2 text-[11px] font-medium"
            style={{ color: "var(--text-muted)" }}
          >
            In this room ({users.length})
          </p>
          <ul className="space-y-1.5">
            {users.map((user) => (
              <li key={user.id} className="flex items-center gap-2 text-sm">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--success)" }}
                />
                {user.tag}
                {user.id === userId && (
                  <span className="text-xs" style={{ color: "var(--text-faint)" }}>
                    (you)
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <AIAgentPanel
        isOpen={isAIPanelOpen}
        prompt={ai.prompt}
        history={ai.history}
        isGenerating={ai.isGenerating}
        error={ai.error}
        autoRespond={ai.autoRespond}
        onToggleAutoRespond={ai.setAutoRespond}
        architectureMode={ai.architectureMode}
        onToggleArchitectureMode={ai.setArchitectureMode}
        onPromptChange={ai.setPrompt}
        onSend={ai.generate}
        onDismissError={ai.dismissError}
        onClose={() => setIsAIPanelOpen(false)}
        onResetConversation={ai.resetConversation}
      />
    </div>
  );
};

export default Canvas;