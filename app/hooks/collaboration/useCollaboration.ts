import { useState, useEffect, useCallback, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { Shape } from "../../types/shapes";
import { User, CursorPositionsMap } from "../../types/collaboration";

export function useCollaboration(
  roomId: string | null,
  userId: string | null,
  userTag: string | null,
  initialShapes: Shape[] = []
) {
  // Socket and connection state
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [shareableLink, setShareableLink] = useState<string>("");
  const [showLinkCopied, setShowLinkCopied] = useState(false);

  // Collaboration state
  const [shapes, setShapes] = useState<Shape[]>(initialShapes);
  const [users, setUsers] = useState<User[]>([]);
  const [cursors, setCursors] = useState<CursorPositionsMap>({});
  const [inProgressShapes, setInProgressShapes] = useState<{
    [userId: string]: Shape;
  }>({});
  const lastBroadcastRef = useRef<number>(0);
  const [drawingUsers, setDrawingUsers] = useState<{
    [userId: string]: boolean;
  }>({});

  // Connect to socket server when roomId and userId are available
  useEffect(() => {
    if (!roomId || !userId || !userTag) return;

    // Socket connection URL
    const socketURL =
      process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001";

    // Create socket connection
    const newSocket = io(socketURL, {
      query: { roomId, userId, userTag },
    });

    // Set up socket event handlers
    newSocket.on("connect", () => {
      console.log("Connected to socket server");
      setIsConnected(true);

      // Generate shareable link for this room
      const baseUrl = window.location.origin;
      const link = `${baseUrl}/room/${roomId}`;
      setShareableLink(link);
    });

    newSocket.on("disconnect", () => {
      console.log("Disconnected from socket server");
      setIsConnected(false);
    });

    newSocket.on("user-joined", (updatedUsers: User[]) => {
      console.log("User joined:", updatedUsers);
      setUsers(updatedUsers);
    });

    newSocket.on("user-left", (updatedUsers: User[]) => {
      console.log("User left:", updatedUsers);
      setUsers(updatedUsers);

      // Clear any in-progress shapes from this user
      setInProgressShapes((current) => {
        const newShapes = { ...current };
        const leftUserIds = updatedUsers.map((u) => u.id);
        Object.keys(newShapes).forEach((uid) => {
          if (!leftUserIds.includes(uid)) {
            delete newShapes[uid];
          }
        });
        return newShapes;
      });

      // Clear any drawing status from this user
      setDrawingUsers((current) => {
        const newStatus = { ...current };
        const leftUserIds = updatedUsers.map((u) => u.id);
        Object.keys(newStatus).forEach((uid) => {
          if (!leftUserIds.includes(uid)) {
            delete newStatus[uid];
          }
        });
        return newStatus;
      });
    });

    newSocket.on("cursor-move", (userId: string, x: number, y: number) => {
      setCursors((prevCursors) => ({
        ...prevCursors,
        [userId]: { x, y },
      }));
    });

    newSocket.on("canvas-data", (sentShapes: Shape[]) => {
      console.log("Received canvas data:", sentShapes.length);
      setShapes(sentShapes);
    });

    newSocket.on("shape-update", (updatedShape: Shape) => {
      console.log("Received shape update:", updatedShape.id);

      setShapes((prevShapes) => {
        // Check if the shape already exists
        const index = prevShapes.findIndex((s) => s.id === updatedShape.id);

        // Create a new array to maintain immutability
        const updatedShapes = [...prevShapes];

        if (index !== -1) {
          // Update existing shape
          updatedShapes[index] = updatedShape;
        } else {
          // Add new shape
          updatedShapes.push(updatedShape);
        }

        return updatedShapes;
      });
    });

    newSocket.on("shape-delete", (shapeIds: (string | number)[]) => {
      console.log("Received shape delete:", shapeIds);

      setShapes((prevShapes) => {
        return prevShapes.filter((shape) => !shapeIds.includes(shape.id));
      });
    });

    newSocket.on("shape-in-progress", (userId: string, shape: Shape | null) => {
      setInProgressShapes((current) => {
        const newShapes = { ...current };

        if (shape) {
          // Mark the shape as in-progress for visual styling
          shape.isInProgress = true;
          newShapes[userId] = shape;
        } else {
          // Remove the in-progress shape if null
          delete newShapes[userId];
        }

        return newShapes;
      });
    });

    newSocket.on("drawing-state", (userId: string, isDrawing: boolean) => {
      setDrawingUsers((current) => ({
        ...current,
        [userId]: isDrawing,
      }));
    });

    // Store socket in state and return cleanup function
    setSocket(newSocket);

    return () => {
      console.log("Cleaning up socket connection");
      newSocket.disconnect();
      setIsConnected(false);
    };
  }, [roomId, userId, userTag]);

  // Send cursor position to other users
  const sendCursorPosition = useCallback(
    (x: number, y: number) => {
      if (!socket || !isConnected) return;

      // Throttle cursor updates to 30 times per second
      const now = Date.now();
      if (now - lastBroadcastRef.current > 33) {
        // ~30fps
        socket.emit("cursor-move", x, y);
        lastBroadcastRef.current = now;
      }
    },
    [socket, isConnected]
  );

  // Send canvas data to the server
  const sendCanvasData = useCallback(
    (shapes: Shape[]) => {
      if (!socket || !isConnected) return;
      console.log("Sending canvas data:", shapes.length);
      socket.emit("canvas-data", shapes);
    },
    [socket, isConnected]
  );

  // Send shape update to the server
  const sendShapeUpdate = useCallback(
    (shape: Shape) => {
      if (!socket || !isConnected) return;
      console.log("Sending shape update:", shape.id);
      socket.emit("shape-update", shape);
    },
    [socket, isConnected]
  );

  // Send shape deletion to the server
  const sendShapeDeletion = useCallback(
    (shapeIds: (string | number)[]) => {
      if (!socket || !isConnected || !shapeIds.length) return;
      console.log("Sending shape deletion:", shapeIds);
      socket.emit("shape-delete", shapeIds);
    },
    [socket, isConnected]
  );

  // Send in-progress shape to collaborators
  const sendShapeInProgress = useCallback(
    (shape: Shape | null) => {
      if (!socket || !isConnected) return;

      // Only send at most 30 updates per second
      const now = Date.now();
      if (now - lastBroadcastRef.current > 33) {
        // ~30fps
        socket.emit("shape-in-progress", shape);
        lastBroadcastRef.current = now;
      }
    },
    [socket, isConnected]
  );

  // Send drawing state (started/stopped) to collaborators
  const sendDrawingState = useCallback(
    (isDrawing: boolean) => {
      if (!socket || !isConnected) return;
      socket.emit("drawing-state", isDrawing);
    },
    [socket, isConnected]
  );

  // Copy shareable link to clipboard
  const copyShareableLink = useCallback(() => {
    if (!shareableLink) return;

    navigator.clipboard
      .writeText(shareableLink)
      .then(() => {
        setShowLinkCopied(true);
        setTimeout(() => setShowLinkCopied(false), 3000);
      })
      .catch((err) => {
        console.error("Failed to copy link: ", err);
      });
  }, [shareableLink]);

  return {
    isConnected,
    users,
    cursors,
    shapes,
    setShapes,
    shareableLink,
    showLinkCopied,
    inProgressShapes,
    drawingUsers,
    sendCursorPosition,
    sendCanvasData,
    sendShapeUpdate,
    sendShapeDeletion,
    sendShapeInProgress,
    sendDrawingState,
    copyShareableLink,
    userId,
  };
}
