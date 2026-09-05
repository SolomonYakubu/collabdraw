"use client";

/**
 * The editor.
 *
 * This component wires the pieces together and owns only genuinely local UI
 * state (active tool, selection, panels). Scene data lives in `useScene`,
 * input in `usePointerInteraction`, drawing in the renderer — previously all
 * three were tangled through 1,300 lines here and in `RoughCanvas`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { nanoid } from "nanoid";
import {
  FiCloud,
  FiDownload,
  FiEdit3,
  FiFolder,
  FiGrid,
  FiImage,
  FiLock,
  FiLogOut,
  FiMonitor,
  FiMoon,
  FiSun,
  FiTrash2,
  FiUnlock,
  FiUser,
  FiUsers,
} from "react-icons/fi";

import {
  isLinearShape,
  type ElementStyle,
  type Point,
  type Shape,
  type ToolType,
  type Viewport,
} from "../types/shapes";
import { getElementBounds, mutateElement } from "../services/canvas/elements";
import {
  removeStaleBindings,
  updateBoundElements,
} from "../services/canvas/bindings";
import { getSelectionBounds } from "../services/canvas/transform";
import { decideInitialScene } from "../services/canvas/hydration";
import {
  loadLocalScene,
  saveLocalScene,
} from "../services/canvas/localScene";
import {
  SCENE_FILE_EXTENSION,
  SCENE_FILE_MIME,
  parseSceneFile,
  sceneFileName,
  serializeScene,
} from "../services/canvas/sceneFile";
import {
  getElementAtPoint,
  HIT_THRESHOLD_PX,
} from "../services/canvas/hitTest";
import { unionBoxes } from "../utils/geometry";
import { clientToWorld, screenToWorld } from "../utils/viewport";

import { useScene, type SceneBroadcast } from "../hooks/canvas/useScene";
import { useViewport } from "../hooks/canvas/useViewport";
import { usePointerInteraction } from "../hooks/canvas/usePointerInteraction";
import { useTextEditor } from "../hooks/canvas/useTextEditor";
import { useKeyboardShortcuts } from "../hooks/canvas/useKeyboardShortcuts";
import { useAIAssistant } from "../hooks/canvas/useAIAssistant";
import { useCanvasCommands } from "../hooks/canvas/useCanvasCommands";
import { useBoardPersistence } from "../hooks/canvas/useBoardPersistence";
import { useLocalSceneAutosave } from "../hooks/canvas/useLocalSceneAutosave";
import { useTheme, type ThemePreference } from "../hooks/useTheme";
import { useEditorPreferences } from "../hooks/useEditorPreferences";
import { useCollaborationContext } from "../context/CollaborationContext";
import { MAX_USER_NAME_LENGTH } from "../services/collaboration/identity";

import CanvasSurface from "./canvas/CanvasSurface";
import TextEditorOverlay from "./canvas/TextEditorOverlay";
import RemoteCursors from "./canvas/RemoteCursors";
import Toolbar from "./canvas/ui/Toolbar";
import StylePanel from "./canvas/ui/StylePanel";
import ContextMenu, { type ContextMenuItem } from "./canvas/ui/ContextMenu";
import MainMenu, { type MainMenuItem } from "./canvas/ui/MainMenu";
import AIAgentPanel from "./canvas/AIAgentPanel";
import ZoomControls from "./canvas/ui/ZoomControls";
import MobileHeader from "./canvas/ui/MobileHeader";
import MobileToolDock from "./canvas/ui/MobileToolDock";
import MobileZoomControl from "./canvas/ui/MobileZoomControl";
import ConfirmDialog from "./ui/ConfirmDialog";
import PromptDialog from "./ui/PromptDialog";
import ToastStack, { useToasts } from "./ui/Toast";

interface CanvasProps {
  initialTool?: ToolType;
  isCollaborative?: boolean;
  /**
   * Present on `/board/[id]`: the scene is durable in Postgres and shared over
   * the socket. Absent on `/`, where the scene is local to this browser.
   */
  boardId?: string;
  initialTitle?: string;
  initialElements?: Shape[];
  initialViewport?: Viewport | null;
  /**
   * Set by `/board/[id]?adopt=local`: this room was just started from the local
   * canvas, so the drawing that was on screen carries into it. Only used when
   * the server has no scene of its own for the board.
   */
  adoptLocalScene?: boolean;
}

const THEME_HINTS: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const THEME_ICONS: Record<ThemePreference, React.ReactNode> = {
  light: <FiSun size={15} />,
  dark: <FiMoon size={15} />,
  system: <FiMonitor size={15} />,
};

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
  boardId,
  initialTitle,
  initialElements,
  initialViewport,
  adoptLocalScene = false,
}) => {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const interactiveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const spacePressedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * No board and no room: the scene comes from this browser. It is read once,
   * synchronously, in the initializer — Excalidraw's `initializeScene()` does
   * the same, and reading it from an effect instead would paint an empty canvas
   * for a frame before swapping the drawing in.
   *
   * A board reads it too when `adoptLocalScene` is set, which is the handover
   * when you start a collaboration session from the local canvas.
   */
  const [restoredLocalScene] = useState(() =>
    typeof window === "undefined" || (boardId && !adoptLocalScene)
      ? null
      : loadLocalScene(),
  );

  /* Anything the server already holds wins; the local scene only fills a gap. */
  const seedElements =
    initialElements && initialElements.length > 0
      ? initialElements
      : (restoredLocalScene?.elements ?? initialElements);

  /*
   * Only a viewport the *server* sent may seed the first render. The elements
   * above are painted into a canvas, so restoring them early is invisible to
   * hydration; the zoom is not — it is text in the zoom readout. Seeding it from
   * localStorage rendered "66%" against the "100%" in the server's HTML, and
   * React answered by throwing the hydrated tree away. The stored viewport is
   * applied just below instead.
   */
  const seedViewport = initialViewport ?? null;

  /*
   * `?adopt=local` is a one-shot instruction. Drop it from the address bar so
   * reloading the room does not re-inject a local scene the room has since
   * moved past — and so the URL you copy is the plain share link.
   */
  useEffect(() => {
    if (!adoptLocalScene) {
      return;
    }
    const url = new URL(window.location.href);
    if (!url.searchParams.has("adopt")) {
      return;
    }
    url.searchParams.delete("adopt");
    window.history.replaceState(null, "", url.toString());
  }, [adoptLocalScene]);

  const [tool, setTool] = useState<ToolType>(initialTool);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /*
   * The pen and the tool lock outlive a reload, and are kept out of the saved
   * scene so they also outlive a session in a room, where scene saving is paused.
   * Their defaults render first and the stored values arrive in an effect — see
   * `useEditorPreferences`.
   */
  const { style, setStyle, toolLocked, setToolLocked } = useEditorPreferences();
  const [isAIPanelOpen, setIsAIPanelOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMobileStyleOpen, setIsMobileStyleOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<Point | null>(null);
  const [title, setTitle] = useState(initialTitle ?? "Untitled board");
  /** Which dialog is on screen, if any. `null` means the canvas is unblocked. */
  const [dialog, setDialog] = useState<
    "rename" | "reset" | "name" | "leave" | null
  >(null);
  const { toasts, show: showToast, dismiss: dismissToast } = useToasts();

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
    scenePersistence,
    sendCursor,
    sendScene,
    sendElements,
    sendDeletions,
    sendPendingElement,
    setEventHandlers,
    userId,
    userName,
    setUserName,
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

  const scene = useScene({
    initialElements: seedElements,
    onChange: handleSceneChange,
  });
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

  const viewportApi = useViewport(containerRef, seedViewport);
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

  /*
   * Restore the pan and zoom the local scene was saved with. A layout effect
   * runs after hydration has matched the server's HTML but before the browser
   * paints, so nothing is ever *drawn* at the wrong zoom — the point of seeding
   * synchronously — while the render React hydrates stays the render it served.
   */
  useLayoutEffect(() => {
    const stored = restoredLocalScene?.viewport;
    if (initialViewport || !stored) {
      return;
    }
    setViewport(stored);
    // Mount only: re-running would drag the canvas back from wherever the
    // person using it has since panned to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Client-side persistence the socket server can't do: record the open,
  // capture thumbnails, and flush the scene on unload while offline.
  useBoardPersistence({
    boardId,
    elements,
    elementsRef,
    viewportRef,
    isConnected,
  });

  /*
   * Local saving stopped working, or started again. A full quota is the
   * realistic cause, and while it lasts the drawing exists only in this tab —
   * so the warning stays up until it is dismissed or the next write succeeds,
   * and it names the way out (a file). Called only on the change, never per
   * write, so it cannot become a stream of toasts.
   */
  const reportAutosaveOutcome = useCallback(
    (saved: boolean) => {
      showToast(
        saved
          ? "Saving to this browser again."
          : "This browser's storage is full, so your drawing is no longer being saved here — use Save to file to keep it.",
        {
          kind: saved ? "success" : "error",
          id: "local-autosave",
          duration: saved ? undefined : 0,
        },
      );
    },
    [showToast],
  );

  /*
   * The room's drawing stopped being kept, or started again.
   *
   * While the socket is connected the server is the writer, so it is the only
   * one that can see this: the board deleted from the gallery in another tab, a
   * scene too large for the column, Postgres unreachable. It used to be a line
   * in the server log while the room drew on into a 24-hour Redis cache, so the
   * work existed right up until it did not. Sticky, single-id and named after
   * the way out, like the local-autosave warning above — and the recovery is
   * only announced to somebody who was told of the problem.
   */
  const wasUndurableRef = useRef(false);
  useEffect(() => {
    const { durable, reason } = scenePersistence;
    if (durable === null) {
      return;
    }

    if (!durable) {
      wasUndurableRef.current = true;
      showToast(
        reason === "deleted"
          ? "This board was deleted, so your drawing is no longer being saved — use Save to file to keep it."
          : reason === "too-large"
            ? "This drawing is too large to save, so it is no longer being kept — use Save to file to keep it."
            : "The board store cannot be reached, so your drawing is not being saved right now.",
        { kind: "error", id: "scene-persistence", duration: 0 },
      );
      return;
    }

    if (wasUndurableRef.current) {
      wasUndurableRef.current = false;
      showToast("This board is being saved again.", {
        kind: "success",
        id: "scene-persistence",
      });
    }
  }, [scenePersistence, showToast]);

  /*
   * Another tab saved a different scene. `useLocalSceneAutosave` has already
   * merged it with this one; what is left is to adopt the result.
   *
   * Deliberately not committed to history: the other tab's edit is not this
   * tab's to undo, and pushing it onto the undo stack would let Ctrl+Z here
   * silently revert work done there. Bindings are re-checked because the merge
   * can drop elements the other tab deleted, and a selection can name one —
   * explicitly, since `applyElements` only re-checks them when the element count
   * changes, and a merge can swap one element for another.
   */
  const adoptRemoteScene = useCallback(
    (merged: Shape[]) => {
      applyElements(() => removeStaleBindings(merged), {
        commit: false,
        broadcast: "none",
        reconcileBindings: false,
      });
      const surviving = new Set(merged.map((element) => element.id));
      setSelectedIds((current) => current.filter((id) => surviving.has(id)));
    },
    [applyElements],
  );

  /*
   * The no-account tier. Disabled the moment there is a board, because then the
   * server holds the authoritative scene and a second, staler copy in
   * localStorage would only fight it — the same reason Excalidraw takes a
   * `"collaboration"` save lock while you are in a room.
   */
  const { clearSavedScene } = useLocalSceneAutosave({
    enabled: !boardId,
    elements,
    elementsRef,
    viewport,
    viewportRef,
    onSaveOutcomeChange: reportAutosaveOutcome,
    onRemoteChange: adoptRemoteScene,
  });

  /**
   * Renaming is a menu action rather than a field on the canvas: a board's name
   * matters in the gallery, not while you are drawing. Best effort — if the
   * PATCH fails the toast says so and the stored title is left alone.
   */
  const renameBoard = useCallback(
    async (next: string) => {
      setDialog(null);
      if (!boardId || next === title) {
        return;
      }
      setTitle(next);
      try {
        const response = await fetch(`/api/boards/${boardId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: next }),
        });
        if (!response.ok) {
          throw new Error(`Rename failed (${response.status})`);
        }
        showToast("Board renamed", { kind: "success", id: "rename" });
      } catch {
        showToast("Renamed here, but the change was not saved.", {
          kind: "error",
          id: "rename",
        });
      }
    },
    [boardId, showToast, title],
  );

  const {
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
  } = useCanvasCommands({
    elementsRef,
    selectedIds,
    setSelectedIds,
    setTool,
    applyElements,
    viewportRef,
  });

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
      // Room hydration on join. If the server has no cached scene yet it sends
      // an empty one; refuse that when we already loaded a scene from the DB,
      // otherwise a freshly-opened board would be blanked. Push ours up instead.
      onInitialScene: (incoming) => {
        const restored = removeStaleBindings(incoming);
        if (decideInitialScene(restored, elementsRef.current) === "push-local") {
          sendScene(elementsRef.current);
          return;
        }
        resetHistory(restored);
      },
      onElements: (incoming) => {
        // Remote edits are authoritative for the elements they mention and are
        // never pushed back onto the wire, which is what caused the previous
        // update storms.
        applyElements(
          (previous) => {
            const byId = new Map(
              previous.map((element) => [element.id, element]),
            );
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
  }, [
    applyElements,
    elementsRef,
    isCollaborative,
    resetHistory,
    sendScene,
    setEventHandlers,
  ]);

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
    return id ? (elements.find((element) => element.id === id) ?? null) : null;
  }, [elements, interaction.visuals.bindingHighlightId]);

  /* ------------------------------------------------------------------ *
   * Commands
   * ------------------------------------------------------------------ */

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
    [applyElements, selectedIds, setStyle],
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
      zoomToFit: () => zoomToFit(selectionBounds ?? sceneBounds),
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
      setContextMenu({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
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
    clipboardRef,
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
   * Document actions (the main menu)
   * ------------------------------------------------------------------ */

  /** Copy the room link, and say whether it landed. */
  const copyLink = useCallback(async () => {
    const copied = await copyShareableLink();
    showToast(
      copied
        ? "Link copied"
        : "Could not copy the link — copy it from the address bar.",
      { kind: copied ? "success" : "error", id: "share-link" },
    );
  }, [copyShareableLink, showToast]);

  /**
   * Start a live session from whatever is on screen. No account, no saved
   * board: a room id is minted here, the local scene is flushed so the room can
   * adopt it, and the socket connects on `/board/<id>` — where the share link
   * lives. This is Excalidraw's "Live collaboration": the room is created from
   * your current drawing, and the drawing itself stays yours locally.
   *
   * The handover *is* that flush — the room reads the scene back out of
   * localStorage — so a refused write would open an empty room and strand the
   * drawing behind it. Staying put and saying so keeps the drawing on screen.
   */
  const startCollaboration = useCallback(() => {
    if (!saveLocalScene(elementsRef.current, viewportRef.current)) {
      showToast(
        "Could not start a session: this browser's storage is full, so the drawing cannot be handed to the room. Save it to a file first.",
        { kind: "error", id: "start-collab" },
      );
      return;
    }
    router.push(`/board/${nanoid(10)}?adopt=local`);
  }, [elementsRef, router, showToast, viewportRef]);

  /**
   * Leave the room for the local canvas at `/`, with or without a copy of what
   * was drawn here.
   *
   * Local autosave is off for as long as a `boardId` is set — the socket server
   * holds the authoritative merged scene, and a second, staler copy would only
   * fight it — so what this browser has saved is still the drawing from *before*
   * you shared. Going back to `/` restored that one, and everything drawn in the
   * room was simply not on this device: the board still had it, but nothing said
   * so and nothing offered to keep it.
   *
   * Excalidraw ends a session by writing the room's scene over the local one with
   * no prompt, which loses the other drawing instead — its own tracker calls that
   * unexpected (excalidraw#909). Both copies are somebody's work, so this asks
   * rather than picking for them.
   */
  const leaveRoom = useCallback(
    (keepCopy: boolean) => {
      setDialog(null);
      if (keepCopy && !saveLocalScene(elementsRef.current, viewportRef.current)) {
        // The same refusal as starting a session: staying in the room is
        // recoverable, leaving with the copy silently unwritten is not.
        showToast(
          "Could not keep a copy: this browser's storage is full. Save the drawing to a file instead, then leave.",
          { kind: "error", id: "leave-room", duration: 0 },
        );
        return;
      }
      router.push("/");
    },
    [elementsRef, router, showToast, viewportRef],
  );

  /**
   * Promote the local scene to a board in Postgres. One request creates the
   * board *with* its scene, so there is nothing to hand over to the next page —
   * `/board/<id>` reads it straight from the database.
   */
  const saveToCloud = useCallback(async () => {
    showToast("Saving…", { id: "save-cloud", duration: 0 });
    try {
      const response = await fetch("/api/boards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          scene: elementsRef.current,
          viewport: viewportRef.current,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Save failed (${response.status})`);
      }

      const { id } = (await response.json()) as { id: string };
      showToast("Saved to your boards", {
        kind: "success",
        id: "save-cloud",
      });
      router.push(`/board/${id}`);
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not save to your boards.",
        { kind: "error", id: "save-cloud" },
      );
    }
  }, [elementsRef, router, showToast, title, viewportRef]);

  /** Download the scene as a `.collabdraw` document. */
  const saveToFile = useCallback(() => {
    const blob = new Blob(
      [serializeScene(elementsRef.current, viewportRef.current)],
      { type: SCENE_FILE_MIME },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = sceneFileName();
    link.click();
    URL.revokeObjectURL(url);
    showToast("Scene saved to your downloads", {
      kind: "success",
      id: "save-file",
    });
  }, [elementsRef, showToast, viewportRef]);

  const openFile = useCallback(() => fileInputRef.current?.click(), []);

  const handleFilePicked = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Clear it first, so picking the same file twice in a row still fires.
      event.target.value = "";
      if (!file) {
        return;
      }

      const parsed = parseSceneFile(await file.text());
      if (!parsed) {
        showToast(`That is not a ${SCENE_FILE_EXTENSION} scene.`, {
          kind: "error",
          id: "open-file",
        });
        return;
      }

      // An opened file replaces the scene, so it becomes the history baseline
      // rather than an undoable edit — and peers need telling explicitly,
      // because resetHistory does not broadcast.
      setSelectedIds([]);
      resetHistory(parsed.elements);
      if (isCollaborative) {
        sendScene(parsed.elements);
      }
      if (parsed.viewport) {
        setViewport(parsed.viewport);
      }
      showToast(file.name, { kind: "success", id: "open-file" });
    },
    [isCollaborative, resetHistory, sendScene, setViewport, showToast],
  );

  /**
   * Change the name over your own cursor. Local-first: it is stored in this
   * browser, so it is also the name the next session you start will carry — the
   * menu offers it whether or not there is a room to announce it to.
   */
  const renameSelf = useCallback(
    (next: string) => {
      setDialog(null);
      if (!setUserName(next)) {
        showToast("That name is empty — keeping the old one.", {
          kind: "error",
          id: "rename-self",
        });
        return;
      }
      showToast("Name updated", { kind: "success", id: "rename-self" });
    },
    [setUserName, showToast],
  );

  const resetCanvas = useCallback(() => {
    setDialog(null);
    clearCanvas();
    // Forgets the stored scene too, and keeps it forgotten — emptying the canvas
    // would otherwise be autosaved a moment later. Declines inside a room, where
    // the stored scene is the solo drawing left behind rather than this one.
    clearSavedScene();
    showToast("Canvas cleared", { kind: "success", id: "reset" });
  }, [clearCanvas, clearSavedScene, showToast]);

  const menuItems = useMemo<MainMenuItem[]>(
    () => [
      {
        id: "open-file",
        label: "Open…",
        icon: <FiFolder size={15} />,
        onSelect: openFile,
      },
      {
        id: "save-file",
        label: "Save to file",
        icon: <FiDownload size={15} />,
        onSelect: saveToFile,
      },
      {
        id: "export-png",
        label: "Export as image",
        icon: <FiImage size={15} />,
        onSelect: exportPNG,
      },
      // In a room the board is already saved, so the slot carries the one
      // document action that is still useful there: its name.
      boardId
        ? {
            id: "rename",
            label: "Rename board…",
            icon: <FiEdit3 size={15} />,
            onSelect: () => setDialog("rename"),
            hint: "Saved",
            separatorBefore: true,
          }
        : {
            id: "save-cloud",
            label: "Save to my boards",
            icon: <FiCloud size={15} />,
            onSelect: () => void saveToCloud(),
            separatorBefore: true,
          },
      {
        id: "boards",
        label: "My boards",
        icon: <FiGrid size={15} />,
        onSelect: () => router.push("/boards"),
      },
      {
        id: "collaborate",
        label: isCollaborative
          ? "Copy collaboration link"
          : "Live collaboration",
        icon: <FiUsers size={15} />,
        onSelect: isCollaborative ? () => void copyLink() : startCollaboration,
        hint: isCollaborative && linkCopied ? "Copied" : undefined,
        separatorBefore: true,
      },
      // The way out, which the menu did not have: the gallery links and the back
      // button leave a room too, but neither is an answer to "I am done here".
      ...(isCollaborative
        ? [
            {
              id: "leave",
              label: "Leave the room…",
              icon: <FiLogOut size={15} />,
              onSelect: () => setDialog("leave"),
            },
          ]
        : []),
      // Also editable in the collaborator list, but that button only exists in a
      // room — and the name you want is the one you set *before* sharing.
      {
        id: "user-name",
        label: "Your name…",
        icon: <FiUser size={15} />,
        onSelect: () => setDialog("name"),
        hint: userName || undefined,
      },
      {
        id: "theme",
        label: "Theme",
        icon: THEME_ICONS[themePreference],
        onSelect: cycleTheme,
        hint: THEME_HINTS[themePreference],
        separatorBefore: true,
      },
      {
        id: "tool-lock",
        label: "Keep selected tool active",
        icon: toolLocked ? <FiLock size={15} /> : <FiUnlock size={15} />,
        onSelect: () => setToolLocked((locked) => !locked),
        hint: toolLocked ? "On" : "Off",
      },
      {
        id: "reset",
        label: "Reset the canvas",
        icon: <FiTrash2 size={15} />,
        onSelect: () => setDialog("reset"),
        danger: true,
        separatorBefore: true,
      },
    ],
    [
      boardId,
      copyLink,
      cycleTheme,
      exportPNG,
      isCollaborative,
      linkCopied,
      openFile,
      router,
      saveToCloud,
      saveToFile,
      setToolLocked,
      startCollaboration,
      themePreference,
      toolLocked,
      userName,
    ],
  );

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

      {/* Open… — one hidden input shared by the desktop menu and the drawer. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={`${SCENE_FILE_EXTENSION},application/json`}
        className="hidden"
        onChange={(event) => void handleFilePicked(event)}
      />

      {/* Mobile top navigation header */}
      <MobileHeader
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onShare={isCollaborative ? () => void copyLink() : startCollaboration}
        shareLabel={
          isCollaborative ? undefined : "Start a live collaboration session"
        }
        linkCopied={linkCopied}
        isCollaborative={isCollaborative}
        isConnected={isConnected}
        users={users}
        currentUserId={userId}
        userName={userName}
        onRenameUser={setUserName}
        onToggleAI={openAIPanel}
        isAIPanelOpen={isAIPanelOpen}
        isAiGenerating={ai.isGenerating}
        aiConversationCount={ai.history.length}
        menuItems={menuItems}
        isMenuOpen={isMobileMenuOpen}
        onToggleMenu={() => setIsMobileMenuOpen((open) => !open)}
      />

      {/* Desktop top-left: the main menu, and nothing else. Renaming a board is
          a menu item, not a field parked on the canvas.

          Layering rule for everything below: a wrapper with a z-index is a
          stacking context, so a popover's own z-index only orders it against its
          siblings — never against another wrapper. Islands that just sit there
          (style panel, zoom) stay on z-30; the two that open something over them
          are on z-40. At equal z-index the later element in the DOM wins, and the
          style panel is rendered after this menu, which is exactly how the open
          menu ended up underneath it. */}
      <div className="pointer-events-none absolute left-3 top-3 z-40 hidden md:flex">
        <MainMenu items={menuItems} />
      </div>

      {/* Outcome messages: saves, copies, an opened file, a failed rename. */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {/* Dialogs. Both replace a native prompt()/confirm(). */}
      <PromptDialog
        open={dialog === "rename"}
        title="Board name"
        description="Shown in your boards."
        initialValue={title}
        confirmLabel="Rename"
        onConfirm={(next) => void renameBoard(next)}
        onCancel={() => setDialog(null)}
      />

      <PromptDialog
        open={dialog === "name"}
        title="Your name"
        description="The label over your cursor, and how you appear in the collaborator list. Stored in this browser."
        initialValue={userName}
        placeholder="e.g. Ada"
        maxLength={MAX_USER_NAME_LENGTH}
        confirmLabel="Save"
        onConfirm={renameSelf}
        onCancel={() => setDialog(null)}
      />

      <ConfirmDialog
        open={dialog === "reset"}
        title="Reset the canvas?"
        description={
          boardId
            ? "Everything on this board is removed for everyone in the room. This cannot be undone."
            : "Everything on the canvas is removed, here and from this browser's saved copy. This cannot be undone."
        }
        confirmLabel="Reset"
        danger
        onConfirm={resetCanvas}
        onCancel={() => setDialog(null)}
      />

      {/* Three answers, because both copies are somebody's work: the room's
          drawing and the one this browser saved before the room existed. The
          description says which is which — and does not promise the board is
          keeping anything while the server is telling us it is not. */}
      <ConfirmDialog
        open={dialog === "leave"}
        title="Leave this room?"
        description={
          scenePersistence.durable === false
            ? "This board is not being saved right now, so a copy on this device may be the only one that survives. Keeping it replaces the drawing this browser saved before you shared."
            : "The room keeps this drawing, and its link still works. On this device the saved drawing is the one from before you shared — keep a copy to replace it, or leave without keeping to hold on to it."
        }
        confirmLabel="Keep a copy"
        secondaryAction={{
          label: "Leave without keeping",
          onSelect: () => leaveRoom(false),
        }}
        cancelLabel="Stay"
        onConfirm={() => leaveRoom(true)}
        onCancel={() => setDialog(null)}
      />

      {/* Desktop top-centre tool island. On z-40 for the same reason as the menu:
          the collaborator list opens out of it. */}
      <div className="pointer-events-none absolute left-1/2 top-3 z-40 hidden -translate-x-1/2 md:flex">
        <Toolbar
          tool={tool}
          onToolChange={handleToolChange}
          toolLocked={toolLocked}
          onToggleToolLock={() => setToolLocked((locked) => !locked)}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
          onShare={isCollaborative ? () => void copyLink() : startCollaboration}
          shareLabel={
            isCollaborative ? undefined : "Start a live collaboration session"
          }
          linkCopied={linkCopied}
          users={isCollaborative ? users : undefined}
          currentUserId={userId}
          userName={userName}
          onRenameUser={setUserName}
          onToggleAI={openAIPanel}
          isAIPanelOpen={isAIPanelOpen}
          isAiGenerating={ai.isGenerating}
          aiConversationCount={ai.history.length}
        />
      </div>

      {/* Mobile bottom tool dock */}
      <MobileToolDock
        tool={tool}
        onToolChange={handleToolChange}
        style={style}
        isStyleSheetOpen={isMobileStyleOpen}
        onToggleStyleSheet={() => setIsMobileStyleOpen((open) => !open)}
        hasSelection={selectedElements.length > 0}
      />

      {/* Desktop left properties panel */}
      {showStylePanel && (
        <div className="pointer-events-none absolute left-3 top-16 z-30 hidden max-h-[calc(100%-5rem)] overflow-y-auto md:block">
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

      {/* Mobile properties bottom sheet */}
      {showStylePanel && isMobileStyleOpen && (
        <div className="fixed inset-0 z-40 flex flex-col md:hidden">
          <div
            className="fixed inset-0 bg-black/30 backdrop-blur-xs transition-opacity"
            onClick={() => setIsMobileStyleOpen(false)}
            aria-hidden="true"
          />
          <div
            className="animate-slide-up relative m-2 mt-auto max-h-[75vh] overflow-y-auto shadow-2xl"
            style={{
              marginBottom:
                "max(4.5rem, calc(env(safe-area-inset-bottom, 0rem) + 4.25rem))",
            }}
          >
            <StylePanel
              style={style}
              onStyleChange={handleStyleChange}
              hasSelection={selectedElements.length > 0}
              showFill={showFillControls}
              showEdgeStyle={showEdgeStyleControls}
              onDelete={() => {
                deleteSelection();
                setIsMobileStyleOpen(false);
              }}
              onDuplicate={duplicateSelection}
              onBringToFront={() => reorderSelection("front")}
              onSendToBack={() => reorderSelection("back")}
              onClose={() => setIsMobileStyleOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Desktop bottom controls: zoom & status */}
      <div className="absolute bottom-3 left-3 z-30 hidden items-center gap-2 md:flex">
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

      {/* Mobile zoom controls — compact chip, bottom-left above the tool dock */}
      <div
        className="pointer-events-none fixed left-2 z-20 flex md:hidden"
        style={{
          bottom:
            "max(4.75rem, calc(env(safe-area-inset-bottom, 0rem) + 4.5rem))",
        }}
      >
        <MobileZoomControl
          zoom={viewport.zoom}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onReset={resetZoom}
          onZoomToFit={() => zoomToFit(selectionBounds ?? sceneBounds)}
        />
      </div>

      {/* Who is in the room lives behind the toolbar's people button — see
          `CollaboratorsButton`. No standing panel on the canvas. */}

      <AIAgentPanel
        isOpen={isAIPanelOpen}
        prompt={ai.prompt}
        history={ai.history}
        isGenerating={ai.isGenerating}
        error={ai.error}
        autoRespond={ai.autoRespond}
        onToggleAutoRespond={ai.setAutoRespond}
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
