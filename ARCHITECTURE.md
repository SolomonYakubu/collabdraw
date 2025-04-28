# CollabDraw Application Architecture & Flow

This document details how the different components of the CollabDraw application connect and interact to provide the collaborative drawing experience.

1.  **Application Entry & Setup (`app/layout.tsx`, `app/page.tsx`)**

    - The application starts with Next.js rendering `app/layout.tsx`. This sets up the basic HTML structure, includes global styles from `app/globals.css`, and importantly, wraps the entire application in the `CollaborationContextProvider` (`app/context/CollaborationContext.tsx`). This makes collaboration state and functions available throughout the component tree.
    - `app/page.tsx` is the main page component. It calculates the desired canvas dimensions based on the window size and renders the central `Canvas` component (`app/components/Canvas.tsx`), passing the dimensions and enabling collaborative mode.

2.  **Main Orchestrator (`app/components/Canvas.tsx`)**

    - This component acts as the primary controller for the drawing experience.
    - **State Management:** It holds key states like the list of `shapes`, the currently `selectedTool`, `selectedColor`, `selectedFillColor`, `selectedId` (for the selected shape), `zoom`, `panOffset`, `isDrawing`, `currentShape` (the shape being actively drawn), etc.
    - **Collaboration Context:** It uses the `useCollaborationContext` hook (`app/context/CollaborationContext.tsx`) to access collaborative state (`isConnected`, `users`, `cursors`, `inProgressShapes`) and functions (`sendCanvasData`, `sendShapeUpdate`, `sendShapeDeletion`, `sendShapeInProgress`, `sendDrawingState`). It uses these functions to broadcast local changes (drawing, moving shapes, deleting) to other users via the backend. It also receives the shared `shapes` array from the context, ensuring the canvas reflects the collaborative state.
    - **Custom Hooks:**
      - `useHistory` (`app/hooks/canvas/useHistory.ts`): Manages the undo/redo stack by taking snapshots of the `shapes` state. It's initialized with the `shapes` and `setShapes` from `app/components/Canvas.tsx`.
      - `useTextEditing` (`app/hooks/canvas/useTextEditing.ts`): Handles the logic for creating, editing, and finishing text shapes.
      - `useCanvasEventHandlers` (`app/hooks/canvas/useCanvasEventHandlers.ts`): This hook is initialized with refs, state variables, and setters from `app/components/Canvas.tsx`. It provides functions (`handleMouseDown`, `handleMouseMove`, `handleMouseUp`, `createTextShape`) that encapsulate the core logic for interpreting user input on the canvas (drawing new shapes, initiating panning).
    - **Rendering:**
      - It renders the `Toolbar` component (`app/components/canvas/ui/Toolbar.tsx`), passing down state (selected tool/color) and callbacks (`onSelectTool`, `onSelectColor`, `onUndo`, `onRedo`, etc.).
      - It renders the `RoughCanvas` component (`app/components/canvas/RoughCanvas.tsx`), which is the actual drawing surface. It passes down the `shapes` (combined from local state and collaborator in-progress shapes), `currentShape`, `selectedId`, collaborator `cursors`, zoom/pan info, and the event handlers from `useCanvasEventHandlers`.
      - It conditionally renders the `ContextMenu` (`app/components/canvas/ui/ContextMenu.tsx`) based on user right-clicks and the `FillColorModal` (`app/components/canvas/ui/FillColorModal.tsx`) when changing fill colors.
    - **Event Handling:** It orchestrates responses to events from the `Toolbar` (tool/color changes), `ContextMenu` (delete, duplicate, layer changes), `FillColorModal` (fill color selection), and keyboard shortcuts (undo/redo, delete). It also handles infinite canvas interactions like zooming (`handleWheel`, `handleZoomIn`, `handleZoomOut`) and panning (delegated to `useCanvasEventHandlers`).

3.  **Rendering Surface (`app/components/canvas/RoughCanvas.tsx`)**

    - This component is responsible for the actual rendering onto the HTML `<canvas>` element using the Rough.js library.
    - **Props:** It receives all necessary data from `Canvas.tsx`, including the shapes to draw, selection state, collaborator cursors, zoom/pan state, and crucially, the event handler callbacks (`onMouseDown`, `onMouseMove`, `onMouseUp`, `onDblClick`).
    - **Internal Hooks:**
      - `useCanvasRendering` (`app/hooks/canvas/useCanvasRendering.ts`): Contains the logic to clear the canvas and iterate through shapes, calling `drawShape` (from `app/services/canvas/drawingService.ts`) for each one via the Rough.js instance. It applies zoom and pan transformations.
      - `useCanvasInteractions` (`app/hooks/canvas/useCanvasInteractions.ts`): Determines if a click hits a shape or a resize handle, manages the state during dragging (`isDragging`) or resizing (`resizeHandle`).
      - `useAlignmentGuides` (`app/hooks/canvas/useAlignmentGuides.ts`): Calculates potential snapping points based on other shapes and draws visual guides during drag/resize operations.
    - **Event Handling:** It attaches its own `handleMouseDown`, `handleMouseMove`, and `handleMouseUp` listeners to the `<canvas>`. These internal handlers first check for interactions managed by `useCanvasInteractions` (like dragging or resizing the selected shape). If no interaction is detected, or if the tool requires drawing, they call the corresponding event handlers passed down from `app/components/Canvas.tsx` (which originated in `useCanvasEventHandlers`) to handle drawing initiation/updates or panning. It translates screen coordinates to canvas world coordinates, considering zoom and pan.
    - **Cursor Rendering:** It renders the `CollaborationCursors` component (`app/components/canvas/CollaborationCursors.tsx`), passing the `cursors` map received from `app/components/Canvas.tsx`.

4.  **Core Drawing & Utilities (`app/services/canvas/drawingService.ts`)**

    - This service contains the fundamental functions for drawing shapes.
    - `drawShape`: The main function called by `useCanvasRendering`. It takes a shape object and uses the Rough.js instance (`roughCanvas`) or the raw canvas `context` to draw the shape based on its `tool` type (e.g., `roughCanvas.rectangle`, `roughCanvas.line`, `drawFreehandPath`, `drawArrow`, `drawText`). It applies styles (stroke, fill, roughness) based on the shape's properties.
    - `getShapeBoundingBox`: Calculates the bounding box for any given shape.
    - `isPointInShape`: Determines if a given coordinate point lies within the bounds of a shape.
    - `drawSelectionHandles` (`app/utils/canvasUtils.ts`): Draws the selection box and resize handles around a selected shape.
    - Helper functions for specific shapes (e.g., `drawFreehandPath` using `perfect-freehand`, `drawArrow`, `drawText`).

5.  **Collaboration Backbone (`app/context/CollaborationContext.tsx`)**

    - **Socket Connection:** Establishes and manages the Socket.IO connection to the backend server (`server.js`) when the component mounts, using connection details (like `roomId`, `userId`) often derived from URL parameters or generated locally.
    - **State:** Holds the collaborative state: `isConnected`, list of `users` in the room, map of collaborator `cursors`, `inProgressShapes` being drawn by others, and the canonical `shapes` array representing the shared canvas state.
    - **Event Listeners:** Sets up listeners for socket events from the server:
      - `active-users`: Updates the `users` list.
      - `cursor-position`: Updates the `cursors` map.
      - `shape-in-progress`: Updates the `inProgressShapes` map.
      - `drawing-state`: Updates flags indicating if a remote user is drawing.
      - `canvas-update`: Receives shape additions/updates/deletions from others and merges them into the local `shapes` state via `setShapes`. Handles full state syncs (`canvas-state-sync`) when joining.
    - **Action Functions:** Provides functions (`sendCanvasData`, `sendShapeUpdate`, `sendShapeDeletion`, `sendShapeInProgress`, `sendDrawingState`, `sendCursorPosition`) that components like `app/components/Canvas.tsx` can call. These functions emit corresponding events via the socket to the backend server.

6.  **Backend Server (`server.js`)**

    - **Connection Handling:** Listens for incoming Socket.IO connections.
    - **Room Management:** Manages users joining and leaving specific rooms (`socket.join(roomId)`). Keeps track of users in each room (`activeRooms`).
    - **Message Broadcasting:** Relays events received from one client to all _other_ clients in the same room (`socket.to(roomId).emit(...)`). This includes:
      - `cursor-position`
      - `shape-in-progress`
      - `drawing-state`
      - `canvas-update` (shape additions, updates, deletions)
    - **State Synchronization:** Handles new users joining a room. It might request the current canvas state from an existing user (`request-canvas-state`) or send a previously stored state (`roomCanvasStates`) to the new user (`canvas-state-sync`). It stores the latest known state for rooms to facilitate this.

7.  **UI Elements (`app/components/canvas/ui`)**
    - `Toolbar.tsx`: Renders buttons. Clicking a tool button calls `onSelectTool` in `app/components/Canvas.tsx`. Clicking a color swatch calls `onSelectColor` or `onSelectFillColor`. Action buttons (Undo, Redo, Clear, Save, Link) call their respective handlers in `app/components/Canvas.tsx`.
    - `ContextMenu.tsx`: Appears on right-click. Buttons call handlers like `onDelete`, `onDuplicate`, `onBringForward`, etc., provided by `app/components/Canvas.tsx`.
    - `FillColorModal.tsx`: Shows color options. Selecting a color calls `onSelectColor` (which is `handleFillColorChange` in `app/components/Canvas.tsx`).
