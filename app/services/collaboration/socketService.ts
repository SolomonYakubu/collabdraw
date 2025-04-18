/**
 * Socket service for real-time collaboration features
 */
import { nanoid } from "nanoid";
import { Socket, io } from "socket.io-client";
import {
  SocketServiceConfig,
  SocketCallbacks,
  User,
  CursorPositionsMap,
  SerializedShape,
} from "../../types/collaboration";
import { Shape } from "../../types/shapes";
import { serializeShapes, deserializeShapes } from "../canvas/drawingService";

// Default socket server URL - can be changed to environment variable if needed
const SOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_SOCKET_SERVER_URL || "http://localhost:3001";

// Maximum reconnection attempts
const MAX_RECONNECT_ATTEMPTS = 5;

// Socket singleton instance
let socketInstance: Socket | null = null;
let connectionAttempts = 0;

/**
 * Get or generate a user ID
 */
export const getUserId = (): string => {
  if (typeof window === "undefined") return nanoid();

  // Check if it exists in localStorage
  const storedUserId = localStorage.getItem("collabdraw_user_id");
  if (storedUserId) {
    return storedUserId;
  }

  // Generate a new user ID
  const userId = nanoid();
  localStorage.setItem("collabdraw_user_id", userId);
  return userId;
};

/**
 * Get or generate a user tag (display name)
 */
export const getUserTag = (): string => {
  if (typeof window === "undefined") return "Guest";

  // Check if it exists in localStorage
  const userTag = localStorage.getItem("collabdraw_user_tag");
  if (userTag) {
    return userTag;
  }

  // Generate a random user tag
  const adjectives = [
    "Happy",
    "Sleepy",
    "Grumpy",
    "Sneezy",
    "Bashful",
    "Dopey",
    "Doc",
  ];
  const nouns = [
    "Penguin",
    "Turtle",
    "Zebra",
    "Elephant",
    "Dolphin",
    "Lion",
    "Tiger",
  ];

  const randomAdjective =
    adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const newTag = `${randomAdjective}${randomNoun}`;

  localStorage.setItem("collabdraw_user_tag", newTag);
  return newTag;
};

/**
 * Get or generate a room ID
 */
export const getRoomId = (): string => {
  if (typeof window === "undefined") return nanoid();

  // Get room ID from URL
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");

  if (roomParam) {
    sessionStorage.setItem("collabdraw_room_id", roomParam);
    return roomParam;
  }

  // Check if we have a room ID in session storage
  const storedRoomId = sessionStorage.getItem("collabdraw_room_id");
  if (storedRoomId) {
    return storedRoomId;
  }

  // Generate a new room ID
  const newRoomId = nanoid();
  sessionStorage.setItem("collabdraw_room_id", newRoomId);
  return newRoomId;
};

/**
 * Initialize socket connection
 */
export const initializeSocket = (
  config?: Partial<SocketServiceConfig>
): Socket => {
  if (typeof window === "undefined") {
    console.log("Socket initialization skipped (server-side rendering)");
    return {} as Socket;
  }

  // Return existing socket if connected
  if (socketInstance && socketInstance.connected) {
    console.log("Reusing existing socket connection");
    return socketInstance;
  }

  try {
    const roomId = config?.roomId || getRoomId();
    const userId = config?.userId || getUserId();
    const userTag = config?.userTag || getUserTag();
    const serverUrl = config?.serverUrl || SOCKET_SERVER_URL;

    console.log(`Connecting to socket server ${serverUrl} for room: ${roomId}`);

    // Create socket connection with reconnection options
    socketInstance = io(serverUrl, {
      query: {
        roomId,
        userId,
        userTag,
      },
      transports: ["websocket", "polling"],
      reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });

    // Add event listeners for connection status
    socketInstance.on("connect", () => {
      console.log("Socket connected successfully");
      connectionAttempts = 0;

      // Request canvas state from other users in the room when joining
      socketInstance?.emit("request-canvas-state");
    });

    socketInstance.on("connect_error", (err) => {
      console.error("Socket connection error:", err);
      connectionAttempts++;

      if (connectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(
          `Failed to connect after ${MAX_RECONNECT_ATTEMPTS} attempts`
        );

        if (typeof window !== "undefined") {
          alert(
            "Could not connect to collaboration server. Please check your network connection and try again."
          );
        }
      }
    });

    socketInstance.on("disconnect", (reason) => {
      console.log(`Socket disconnected: ${reason}`);
    });

    return socketInstance;
  } catch (error) {
    console.error("Failed to initialize socket:", error);

    if (typeof window !== "undefined") {
      alert(
        "Failed to connect to collaboration server. You can still use the app in offline mode."
      );
    }

    // Return a mock socket for offline use
    return {
      emit: () => {},
      on: () => {},
      disconnect: () => {},
      connected: false,
      id: "offline",
    } as unknown as Socket;
  }
};

/**
 * Disconnect socket
 */
export const disconnectSocket = (): void => {
  if (socketInstance && typeof socketInstance.disconnect === "function") {
    socketInstance.disconnect();
    socketInstance = null;
    console.log("Socket disconnected manually");
  }
};

/**
 * Subscribe to socket events
 */
export const subscribeToEvents = (
  socket: Socket,
  callbacks: SocketCallbacks
): void => {
  if (!socket || !socket.connected) return;

  const roomId = getRoomId();

  // Listen for cursor position updates
  socket.on("cursor-position", (data) => {
    if (data.userId === getUserId()) return; // Ignore own cursor
    if (callbacks.onCursorUpdate) {
      // Pass the cursor data directly
      callbacks.onCursorUpdate({
        userId: data.userId,
        x: data.x,
        y: data.y,
        tag: data.userTag,
      });
    }
  });

  // Listen for canvas updates
  socket.on("canvas-update", (data) => {
    if (data.userId === getUserId()) return; // Ignore own updates

    if (callbacks.onCanvasUpdate && data.shapes) {
      try {
        // Convert serialized shapes to our Shape format
        const receivedShapes = deserializeShapes(data.shapes);
        console.log(
          `Received ${receivedShapes.length} shapes from user ${data.userId}`
        );

        // Update the canvas with received shapes
        callbacks.onCanvasUpdate(receivedShapes);
      } catch (error) {
        console.error("Error processing received shapes:", error);
      }
    }
  });

  // Listen for canvas state sync (for new users joining)
  socket.on("canvas-state-sync", (data) => {
    if (data.userId === getUserId()) return; // Ignore own updates

    if (callbacks.onCanvasUpdate && data.shapes) {
      try {
        // Convert serialized shapes to our Shape format
        const receivedShapes = deserializeShapes(data.shapes);
        console.log(
          `Received initial canvas state with ${receivedShapes.length} shapes`
        );

        // Update the canvas with received shapes
        callbacks.onCanvasUpdate(receivedShapes);
      } catch (error) {
        console.error("Error processing initial canvas state:", error);
      }
    }
  });

  // Listen for requests for canvas state (when a new user joins)
  socket.on("request-canvas-state", (data) => {
    if (callbacks.onCanvasStateRequest) {
      // Call the handler which will send canvas state to the new user
      callbacks.onCanvasStateRequest(data.targetUserId);
    }
  });

  // Listen for drawing state updates
  socket.on("drawing-state", (data) => {
    if (data.userId === getUserId()) return; // Ignore own updates
    if (callbacks.onDrawingStateChange) {
      callbacks.onDrawingStateChange(data.userId, data.isDrawing);
    }
  });

  // Listen for active users updates
  socket.on("active-users", (data) => {
    if (callbacks.onUsersUpdate) {
      callbacks.onUsersUpdate(data.users);
    }
  });

  // Join the room
  socket.emit("join-room", {
    roomId,
    userId: getUserId(),
    userTag: getUserTag(),
  });

  console.log(`Joined room: ${roomId}`);
};

/**
 * Broadcast canvas data
 */
export const broadcastCanvasData = (
  socket: Socket,
  shapes: SerializedShape[]
): void => {
  if (!socket || !socket.connected) return;

  try {
    socket.emit("canvas-update", {
      roomId: getRoomId(),
      userId: getUserId(),
      shapes,
    });
  } catch (error) {
    console.error("Error broadcasting canvas data:", error);
  }
};

/**
 * Broadcast specific shape update
 * Used for sending individual shape updates (like after drag)
 */
export const broadcastShapeUpdate = (socket: Socket, shape: Shape): void => {
  if (!socket || !socket.connected) return;

  try {
    // Serialize the single shape
    const serialized = [
      {
        className: getShapeClassName(shape.tool),
        attrs: { ...shape, tool: undefined },
      },
    ];

    socket.emit("canvas-update", {
      roomId: getRoomId(),
      userId: getUserId(),
      shapes: serialized,
      isPartial: true, // Flag to indicate this is a partial update
    });
  } catch (error) {
    console.error("Error broadcasting shape update:", error);
  }
};

/**
 * Helper function to convert shape tool type to Konva class name
 */
function getShapeClassName(tool: Shape["tool"]): string {
  switch (tool) {
    case "Freehand":
    case "Line":
      return "Line";
    case "Arrow":
      return "Arrow";
    case "Square":
      return "Rect";
    case "Circle":
      return "Circle";
    case "Text":
      return "Text";
    default:
      return "";
  }
}

/**
 * Send canvas state to a specific user (responding to state request)
 */
export const sendCanvasState = (
  socket: Socket,
  targetUserId: string,
  shapes: SerializedShape[]
): void => {
  if (!socket || !socket.connected) return;

  try {
    socket.emit("canvas-state-sync", {
      roomId: getRoomId(),
      userId: getUserId(),
      targetUserId,
      shapes,
    });
    console.log(`Sent canvas state to user ${targetUserId}`);
  } catch (error) {
    console.error("Error sending canvas state:", error);
  }
};

/**
 * Broadcast cursor position
 */
export const broadcastCursorPosition = (
  socket: Socket,
  x: number,
  y: number
): void => {
  if (!socket || !socket.connected) return;

  try {
    socket.emit("cursor-position", {
      roomId: getRoomId(),
      userId: getUserId(),
      userTag: getUserTag(),
      x,
      y,
    });
  } catch (error) {
    console.error("Error broadcasting cursor position:", error);
  }
};

/**
 * Broadcast drawing state
 */
export const broadcastDrawingState = (
  socket: Socket,
  isDrawing: boolean
): void => {
  if (!socket || !socket.connected) return;

  try {
    socket.emit("drawing-state", {
      roomId: getRoomId(),
      userId: getUserId(),
      isDrawing,
    });
  } catch (error) {
    console.error("Error broadcasting drawing state:", error);
  }
};

/**
 * Get active users
 */
export const getActiveUsers = (socket: Socket): Promise<User[]> => {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) {
      resolve([]);
      return;
    }

    try {
      socket.emit(
        "get-active-users",
        { roomId: getRoomId() },
        (response: any) => {
          if (response && response.users) {
            resolve(response.users);
          } else {
            console.warn("Received empty users response");
            resolve([]);
          }
        }
      );
    } catch (error) {
      console.error("Error getting active users:", error);
      resolve([]);
    }
  });
};

/**
 * Generate shareable link
 */
export const generateShareableLink = (): string => {
  if (typeof window === "undefined") return "";

  const roomId = getRoomId();
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);

  return url.toString();
};

/**
 * Copy room link to clipboard
 */
export const copyRoomLink = async (): Promise<boolean> => {
  if (typeof window === "undefined") return false;

  const link = generateShareableLink();

  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch (error) {
    console.error("Failed to copy link to clipboard:", error);
    return false;
  }
};
