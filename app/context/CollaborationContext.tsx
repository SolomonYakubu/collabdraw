"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { io, Socket } from "socket.io-client";
import { nanoid } from "nanoid";
import { Shape } from "../types/shapes";
import { CursorPositionsMap, User } from "../types/collaboration";
import AppCursors from "../components/AppCursors";

interface CollaborationContextProps {
  socket: Socket | null;
  isConnected: boolean;
  roomId: string | null;
  userId: string | null;
  users: User[];
  cursors: CursorPositionsMap;
  inProgressShapes: { [key: string]: Shape };
  shapes: Shape[];
  setShapes: React.Dispatch<React.SetStateAction<Shape[]>>;
  shareableLink: string;
  showLinkCopied: boolean;
  copyShareableLink: () => void;
  sendCanvasData: (shapes: Shape[]) => void;
  sendShapeUpdate: (shape: Shape) => void;
  sendShapeDeletion: (shapeIds: string[]) => void;
  sendShapeInProgress: (shape: Shape | null) => void;
  sendDrawingState: (isDrawing: boolean) => void;
}

const CollaborationContext = createContext<
  CollaborationContextProps | undefined
>(undefined);

export function useCollaborationContext() {
  const context = useContext(CollaborationContext);
  if (context === undefined) {
    throw new Error(
      "useCollaborationContext must be used within a CollaborationContextProvider"
    );
  }
  return context;
}

export const CollaborationContextProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  // Socket and connection state
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // User and room identification
  const [roomId, setRoomId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const userTagRef = useRef<string>("");

  // Collaboration data
  const [users, setUsers] = useState<User[]>([]);
  const [cursors, setCursors] = useState<CursorPositionsMap>({});
  const [inProgressShapes, setInProgressShapes] = useState<{
    [key: string]: Shape;
  }>({});
  const [shapes, setShapes] = useState<Shape[]>([]);

  // UI state
  const [shareableLink, setShareableLink] = useState<string>("");
  const [showLinkCopied, setShowLinkCopied] = useState(false);
  const [isClient, setIsClient] = useState(false);

  // Flags to prevent loops
  const isProcessingUpdate = useRef<boolean>(false);
  const lastInProgressSentId = useRef<string | number | null>(null);
  const lastMouseMoveTime = useRef<number>(0);

  // Only run on client-side
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Initialize socket connection and set up event handlers
  useEffect(() => {
    if (!isClient) return;

    console.log("Initializing collaboration context");

    // Generate user ID and tag
    const storedUserId = localStorage.getItem("collabdraw_userId") || nanoid(8);
    localStorage.setItem("collabdraw_userId", storedUserId);
    setUserId(storedUserId);

    const tag = generateUserTag();
    userTagRef.current = tag;

    // Get or generate room ID
    let currentRoomId = new URLSearchParams(window.location.search).get(
      "roomId"
    );
    if (!currentRoomId) {
      currentRoomId = nanoid(10);
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set("roomId", currentRoomId);
      window.history.pushState({}, "", newUrl);
    }
    setRoomId(currentRoomId);

    // Create shareable link
    const baseUrl = window.location.origin + window.location.pathname;
    setShareableLink(`${baseUrl}?roomId=${currentRoomId}`);

    // Connect to socket server
    const socket = io(
      process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001",
      {
        query: {
          roomId: currentRoomId,
          userId: storedUserId,
          userTag: tag,
        },
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        transports: ["websocket", "polling"],
      }
    );

    socketRef.current = socket;

    // Connection events
    socket.on("connect", () => {
      console.log("Socket connected");
      setIsConnected(true);

      socket.emit("join-room", {
        roomId: currentRoomId,
        userId: storedUserId,
        userTag: tag,
      });
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected");
      setIsConnected(false);
    });

    // Users and canvas state
    socket.on("active-users", (data) => {
      setUsers(data.users);
    });

    socket.on("canvas-state-sync", (data) => {
      if (
        data.userId !== storedUserId &&
        data.shapes &&
        Array.isArray(data.shapes)
      ) {
        console.log("Received initial canvas state:", data.shapes.length);
        isProcessingUpdate.current = true;
        setShapes(data.shapes);
        setTimeout(() => {
          isProcessingUpdate.current = false;
        }, 100);
      }
    });

    socket.on("request-canvas-state", (data) => {
      socket.emit("canvas-state-response", {
        roomId: currentRoomId,
        userId: storedUserId,
        targetUserId: data.targetUserId,
        shapes: shapes,
      });
    });

    // Collaboration events
    socket.on("cursor-position", (data) => {
      if (data.userId !== storedUserId) {
        setCursors((prev) => ({
          ...prev,
          [data.userId]: {
            x: data.x,
            y: data.y,
            tag: data.tag || "User",
          },
        }));
      }
    });

    socket.on("shape-in-progress", (data) => {
      if (data.userId !== storedUserId) {
        console.log("Received in-progress shape from", data.userId);
        setInProgressShapes((prev) => ({
          ...prev,
          [data.userId]: data.shape,
        }));
      }
    });

    socket.on("drawing-state", (data) => {
      if (data.userId !== storedUserId && !data.isDrawing) {
        console.log("User stopped drawing:", data.userId);
        setInProgressShapes((prev) => {
          const newState = { ...prev };
          delete newState[data.userId];
          return newState;
        });
      }
    });

    socket.on("canvas-update", (data) => {
      if (data.userId !== storedUserId) {
        isProcessingUpdate.current = true;

        // Apply shape updates
        if (data.shapes && Array.isArray(data.shapes)) {
          if (data.fullUpdate) {
            setShapes(data.shapes);
          } else {
            setShapes((prevShapes) => {
              const newShapes = [...prevShapes];
                data.shapes.forEach((incomingShape: Shape) => {
                const index: number = newShapes.findIndex(
                  (s: Shape) => s.id === incomingShape.id
                );
                if (index >= 0) {
                  newShapes[index] = incomingShape;
                } else {
                  newShapes.push(incomingShape);
                }
                });
              return newShapes;
            });
          }
        }

        // Handle shape deletions
        if (data.deletedShapeIds && Array.isArray(data.deletedShapeIds)) {
          setShapes((prevShapes) =>
            prevShapes.filter(
              (shape) => !data.deletedShapeIds.includes(shape.id)
            )
          );
        }

        setTimeout(() => {
          isProcessingUpdate.current = false;
        }, 100);
      }
    });

    // Mouse move handler for cursor sharing
    const handleMouseMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastMouseMoveTime.current < 50) return; // 50ms throttle

      lastMouseMoveTime.current = now;

      if (socket.connected && currentRoomId && storedUserId) {
        socket.emit("cursor-position", {
          roomId: currentRoomId,
          userId: storedUserId,
          x: e.clientX,
          y: e.clientY,
          tag: tag,
        });
      }
    };

    document.addEventListener("mousemove", handleMouseMove);

    // Cleanup function
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      socket.disconnect();
    };
  }, [isClient]);

  // Update shapes ref when state changes
  useEffect(() => {
    console.log("Shapes updated:", shapes.length);
  }, [shapes]);

  // Generate a user tag
  const generateUserTag = (): string => {
    const adjectives = [
      "Happy",
      "Sunny",
      "Clever",
      "Swift",
      "Bright",
      "Creative",
      "Smart",
      "Quick",
      "Calm",
      "Friendly",
    ];
    const nouns = [
      "Tiger",
      "Panda",
      "Eagle",
      "Fox",
      "Dolphin",
      "Wolf",
      "Bear",
      "Hawk",
      "Koala",
      "Owl",
    ];

    const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];

    return `${randomAdj}${randomNoun}`;
  };

  // Copy shareable link
  const copyShareableLink = useCallback(() => {
    if (!shareableLink) return;

    try {
      navigator.clipboard.writeText(shareableLink);
      setShowLinkCopied(true);
      setTimeout(() => setShowLinkCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy link:", err);
    }
  }, [shareableLink]);

  // Send full canvas state
  const sendCanvasData = useCallback(
    (shapesData: Shape[]) => {
      if (isProcessingUpdate.current || !socketRef.current?.connected) return;

      const socket = socketRef.current;
      const currentRoomId = roomId;
      const currentUserId = userId;

      if (socket && currentRoomId && currentUserId) {
        console.log("Sending full canvas update:", shapesData.length, "shapes");
        socket.emit("canvas-update", {
          roomId: currentRoomId,
          userId: currentUserId,
          shapes: shapesData,
          fullUpdate: true,
        });
      }
    },
    [roomId, userId]
  );

  // Send single shape update
  const sendShapeUpdate = useCallback(
    (shape: Shape) => {
      if (isProcessingUpdate.current || !socketRef.current?.connected) return;

      const socket = socketRef.current;
      const currentRoomId = roomId;
      const currentUserId = userId;

      if (socket && currentRoomId && currentUserId) {
        socket.emit("canvas-update", {
          roomId: currentRoomId,
          userId: currentUserId,
          shapes: [shape],
          isPartial: true,
        });
      }
    },
    [roomId, userId]
  );

  // Send shape deletion
  const sendShapeDeletion = useCallback(
    (shapeIds: string[]) => {
      if (
        isProcessingUpdate.current ||
        !socketRef.current?.connected ||
        shapeIds.length === 0
      )
        return;

      const socket = socketRef.current;
      const currentRoomId = roomId;
      const currentUserId = userId;

      if (socket && currentRoomId && currentUserId) {
        socket.emit("canvas-update", {
          roomId: currentRoomId,
          userId: currentUserId,
          deletedShapeIds: shapeIds,
          isPartial: true,
        });
      }
    },
    [roomId, userId]
  );

  // Send in-progress shape
  const sendShapeInProgress = useCallback(
    (shape: Shape | null) => {
      if (!socketRef.current?.connected || !shape) return;

      // Don't send the same shape repeatedly
      if (lastInProgressSentId.current === shape.id) return;

      const socket = socketRef.current;
      const currentRoomId = roomId;
      const currentUserId = userId;

      if (socket && currentRoomId && currentUserId) {
        lastInProgressSentId.current = shape.id;

        // Clone the shape with reduced opacity
        const inProgressShape = {
          ...shape,
          opacity: 0.4,
        };

        socket.emit("shape-in-progress", {
          roomId: currentRoomId,
          userId: currentUserId,
          shape: inProgressShape,
        });

        // Reset tracking after a short delay
        setTimeout(() => {
          lastInProgressSentId.current = null;
        }, 100);
      }
    },
    [roomId, userId]
  );

  // Send drawing state (started/stopped)
  const sendDrawingState = useCallback(
    (isDrawing: boolean) => {
      if (!socketRef.current?.connected) return;

      const socket = socketRef.current;
      const currentRoomId = roomId;
      const currentUserId = userId;

      if (socket && currentRoomId && currentUserId) {
        console.log("Sending drawing state:", isDrawing);
        socket.emit("drawing-state", {
          roomId: currentRoomId,
          userId: currentUserId,
          isDrawing,
        });
      }
    },
    [roomId, userId]
  );

  // Context value
  const contextValue: CollaborationContextProps = {
    socket: socketRef.current,
    isConnected,
    roomId,
    userId,
    users,
    cursors,
    inProgressShapes,
    shapes,
    setShapes,
    shareableLink,
    showLinkCopied,
    copyShareableLink,
    sendCanvasData,
    sendShapeUpdate,
    sendShapeDeletion,
    sendShapeInProgress,
    sendDrawingState,
  };

  return (
    <CollaborationContext.Provider value={contextValue}>
      {children}
      {isClient && <AppCursors cursors={cursors} currentUserId={userId} />}
    </CollaborationContext.Provider>
  );
};
