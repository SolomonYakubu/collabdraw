"use client";

/**
 * Collaboration transport.
 *
 * This provider now does one thing: move messages between the socket and
 * whoever is holding the scene. It no longer owns the element list, so there is
 * a single source of truth (the editor's scene) instead of two that had to be
 * kept in sync.
 *
 * Fixed here as well:
 *  - `request-canvas-state` used to answer from a `shapes` value captured on
 *    first render, so every user who joined an existing room received an empty
 *    canvas. It now asks the scene for its current contents.
 *  - connection problems raised `alert()` on every one of the five reconnect
 *    attempts. Connection state is surfaced in the UI instead.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { io, type Socket } from "socket.io-client";
import { nanoid } from "nanoid";

import type { Point, Shape } from "../types/shapes";
import type { CursorPositionsMap, User } from "../types/collaboration";
import { restoreElements } from "../services/canvas/elements";

const CURSOR_THROTTLE_MS = 50;
const PENDING_THROTTLE_MS = 40;
const STALE_CURSOR_MS = 10_000;

export interface CollaborationEventHandlers {
  /** Replace the whole scene (initial sync, remote undo/redo, clear). */
  onScene?: (elements: Shape[]) => void;
  /** Merge individual elements. */
  onElements?: (elements: Shape[]) => void;
  onDeletions?: (ids: string[]) => void;
  /** Called when a peer asks for the current scene. */
  getScene?: () => Shape[];
}

interface CollaborationContextValue {
  isConnected: boolean;
  isEnabled: boolean;
  roomId: string | null;
  userId: string | null;
  users: User[];
  cursors: CursorPositionsMap;
  remoteInProgress: Record<string, Shape>;
  shareableLink: string;
  linkCopied: boolean;
  copyShareableLink: () => void;
  sendCursor: (point: Point) => void;
  sendScene: (elements: Shape[]) => void;
  sendElements: (elements: Shape[]) => void;
  sendDeletions: (ids: string[]) => void;
  sendPendingElement: (element: Shape | null) => void;
  setEventHandlers: (handlers: CollaborationEventHandlers) => void;
}

const CollaborationContext = createContext<CollaborationContextValue | undefined>(
  undefined,
);

export function useCollaborationContext(): CollaborationContextValue {
  const context = useContext(CollaborationContext);

  if (!context) {
    throw new Error(
      "useCollaborationContext must be used within a CollaborationContextProvider",
    );
  }

  return context;
}

const ADJECTIVES = [
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

const NOUNS = [
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

const generateUserTag = (): string =>
  `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]}${
    NOUNS[Math.floor(Math.random() * NOUNS.length)]
  }`;

const readStoredUserId = (): string => {
  try {
    const stored = window.localStorage.getItem("collabdraw_userId");
    if (stored) {
      return stored;
    }
    const created = nanoid(8);
    window.localStorage.setItem("collabdraw_userId", created);
    return created;
  } catch {
    // Private browsing or blocked storage: a per-session id is fine.
    return nanoid(8);
  }
};

export const CollaborationContextProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef<CollaborationEventHandlers>({});

  const [isClient, setIsClient] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [cursors, setCursors] = useState<CursorPositionsMap>({});
  const [remoteInProgress, setRemoteInProgress] = useState<Record<string, Shape>>(
    {},
  );
  const [shareableLink, setShareableLink] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);

  const identityRef = useRef<{ roomId: string; userId: string; tag: string } | null>(
    null,
  );
  const lastCursorSentRef = useRef(0);
  const lastPendingSentRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => setIsClient(true), []);

  const setEventHandlers = useCallback(
    (handlers: CollaborationEventHandlers) => {
      handlersRef.current = handlers;
    },
    [],
  );

  useEffect(() => {
    if (!isClient) {
      return;
    }

    const currentUserId = readStoredUserId();
    const tag = generateUserTag();

    let currentRoomId = new URLSearchParams(window.location.search).get("roomId");
    if (!currentRoomId) {
      currentRoomId = nanoid(10);
      const url = new URL(window.location.href);
      url.searchParams.set("roomId", currentRoomId);
      window.history.replaceState({}, "", url);
    }

    identityRef.current = { roomId: currentRoomId, userId: currentUserId, tag };
    setUserId(currentUserId);
    setRoomId(currentRoomId);
    setShareableLink(
      `${window.location.origin}${window.location.pathname}?roomId=${currentRoomId}`,
    );

    const socketUrl =
      process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001";

    const socket = io(socketUrl, {
      query: { roomId: currentRoomId, userId: currentUserId, userTag: tag },
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      transports: ["websocket", "polling"],
      timeout: 10_000,
    });

    socketRef.current = socket;

    const isSelf = (candidate: unknown) => candidate === currentUserId;

    socket.on("connect", () => {
      setIsConnected(true);
      socket.emit("join-room", {
        roomId: currentRoomId,
        userId: currentUserId,
        userTag: tag,
      });
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
      setUsers([]);
      setCursors({});
      setRemoteInProgress({});
    });

    socket.on("connect_error", (error: Error) => {
      // Expected when the socket server is not running; the UI shows "Offline".
      console.warn(`Collaboration unavailable at ${socketUrl}:`, error.message);
      setIsConnected(false);
    });

    socket.on("active-users", (data: { users?: User[] }) => {
      setUsers(Array.isArray(data?.users) ? data.users : []);
    });

    socket.on("canvas-state-sync", (data: { userId?: string; shapes?: unknown }) => {
      if (isSelf(data?.userId)) {
        return;
      }
      handlersRef.current.onScene?.(restoreElements(data?.shapes));
    });

    socket.on("request-canvas-state", (data: { targetUserId?: string }) => {
      socket.emit("canvas-state-response", {
        roomId: currentRoomId,
        userId: currentUserId,
        targetUserId: data?.targetUserId,
        shapes: handlersRef.current.getScene?.() ?? [],
      });
    });

    socket.on(
      "cursor-position",
      (data: { userId?: string; x?: number; y?: number; tag?: string }) => {
        if (
          isSelf(data?.userId) ||
          typeof data?.userId !== "string" ||
          typeof data?.x !== "number" ||
          typeof data?.y !== "number"
        ) {
          return;
        }

        setCursors((current) => ({
          ...current,
          [data.userId as string]: {
            x: data.x as number,
            y: data.y as number,
            tag: data.tag || "User",
            updatedAt: Date.now(),
          },
        }));
      },
    );

    socket.on("shape-in-progress", (data: { userId?: string; shape?: unknown }) => {
      if (isSelf(data?.userId) || typeof data?.userId !== "string") {
        return;
      }

      const [element] = restoreElements([data.shape]);

      setRemoteInProgress((current) => {
        if (!element) {
          const next = { ...current };
          delete next[data.userId as string];
          return next;
        }
        return {
          ...current,
          [data.userId as string]: { ...element, isInProgress: true },
        };
      });
    });

    socket.on("drawing-state", (data: { userId?: string; isDrawing?: boolean }) => {
      if (isSelf(data?.userId) || data?.isDrawing !== false) {
        return;
      }

      setRemoteInProgress((current) => {
        const next = { ...current };
        delete next[data.userId as string];
        return next;
      });
    });

    socket.on(
      "canvas-update",
      (data: {
        userId?: string;
        shapes?: unknown;
        deletedShapeIds?: unknown;
        fullUpdate?: boolean;
      }) => {
        if (isSelf(data?.userId)) {
          return;
        }

        if (Array.isArray(data?.shapes)) {
          const elements = restoreElements(data.shapes);
          if (data.fullUpdate) {
            handlersRef.current.onScene?.(elements);
          } else if (elements.length > 0) {
            handlersRef.current.onElements?.(elements);
          }
        }

        if (Array.isArray(data?.deletedShapeIds)) {
          const ids = data.deletedShapeIds.filter(
            (id): id is string => typeof id === "string",
          );
          if (ids.length > 0) {
            handlersRef.current.onDeletions?.(ids);
          }
        }
      },
    );

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isClient]);

  /* Drop cursors of people who stopped moving, so labels do not pile up. */
  useEffect(() => {
    const interval = window.setInterval(() => {
      const cutoff = Date.now() - STALE_CURSOR_MS;

      setCursors((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(
            ([, cursor]) => (cursor.updatedAt ?? 0) >= cutoff,
          ),
        );
        return Object.keys(next).length === Object.keys(current).length
          ? current
          : next;
      });
    }, 5000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const emit = useCallback((event: string, payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    const identity = identityRef.current;

    if (!socket?.connected || !identity) {
      return;
    }

    socket.emit(event, {
      roomId: identity.roomId,
      userId: identity.userId,
      ...payload,
    });
  }, []);

  const sendCursor = useCallback(
    (point: Point) => {
      const now = Date.now();
      if (now - lastCursorSentRef.current < CURSOR_THROTTLE_MS) {
        return;
      }
      lastCursorSentRef.current = now;

      emit("cursor-position", {
        x: point.x,
        y: point.y,
        tag: identityRef.current?.tag,
      });
    },
    [emit],
  );

  const sendScene = useCallback(
    (elements: Shape[]) => {
      emit("canvas-update", { shapes: elements, fullUpdate: true });
    },
    [emit],
  );

  const sendElements = useCallback(
    (elements: Shape[]) => {
      if (elements.length === 0) {
        return;
      }
      emit("canvas-update", { shapes: elements, isPartial: true });
    },
    [emit],
  );

  const sendDeletions = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) {
        return;
      }
      emit("canvas-update", { deletedShapeIds: ids, isPartial: true });
    },
    [emit],
  );

  const sendPendingElement = useCallback(
    (element: Shape | null) => {
      if (!element) {
        emit("drawing-state", { isDrawing: false });
        lastPendingSentRef.current = 0;
        return;
      }

      const now = Date.now();
      if (now - lastPendingSentRef.current < PENDING_THROTTLE_MS) {
        return;
      }
      lastPendingSentRef.current = now;

      emit("shape-in-progress", { shape: { ...element, isInProgress: true } });
    },
    [emit],
  );

  const copyShareableLink = useCallback(() => {
    if (!shareableLink) {
      return;
    }

    const done = () => {
      setLinkCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setLinkCopied(false), 2000);
    };

    navigator.clipboard?.writeText(shareableLink).then(done, (error: unknown) => {
      console.warn("Could not copy the share link:", error);
    });
  }, [shareableLink]);

  const value = useMemo<CollaborationContextValue>(
    () => ({
      isConnected,
      isEnabled: isClient,
      roomId,
      userId,
      users,
      cursors,
      remoteInProgress,
      shareableLink,
      linkCopied,
      copyShareableLink,
      sendCursor,
      sendScene,
      sendElements,
      sendDeletions,
      sendPendingElement,
      setEventHandlers,
    }),
    [
      copyShareableLink,
      cursors,
      isClient,
      isConnected,
      linkCopied,
      remoteInProgress,
      roomId,
      sendCursor,
      sendDeletions,
      sendElements,
      sendPendingElement,
      sendScene,
      setEventHandlers,
      shareableLink,
      userId,
      users,
    ],
  );

  return (
    <CollaborationContext.Provider value={value}>
      {children}
    </CollaborationContext.Provider>
  );
};
