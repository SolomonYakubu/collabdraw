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
 *  - the display name was minted fresh on every mount, so the label over your
 *    cursor was a different random animal after each reload. It now comes from
 *    `services/collaboration/identity`, which persists it, and `setUserName`
 *    lets you change it without tearing the socket down.
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

import type { Point, Shape } from "../types/shapes";
import type { CursorPositionsMap, User } from "../types/collaboration";
import { restoreElements } from "../services/canvas/elements";
import {
  USER_NAME_KEY,
  normalizeUserName,
  readUserId,
  readUserName,
  writeUserName,
} from "../services/collaboration/identity";
import { subscribeToStorageKey } from "../services/storageSync";

const CURSOR_THROTTLE_MS = 50;
const PENDING_THROTTLE_MS = 40;
const STALE_CURSOR_MS = 10_000;

/**
 * Why the room's drawing is not being kept, in the socket server's own words
 * (`server/src/db.js`'s write outcomes). The two runtimes share no module, so
 * these strings are the contract.
 */
export type ScenePersistenceReason = "deleted" | "too-large" | "unreachable";

const PERSISTENCE_REASONS: readonly string[] = [
  "deleted",
  "too-large",
  "unreachable",
];

export interface ScenePersistence {
  /**
   * Whether the server's last durable write succeeded — `null` until it has
   * attempted one, which is not the same as "yes". A room nobody has edited has
   * nothing to report, and a deployment with no store of record never reports.
   */
  durable: boolean | null;
  reason: ScenePersistenceReason | null;
}

/** Module-level so the identity is stable: see the setter below. */
const PERSISTENCE_UNKNOWN: ScenePersistence = { durable: null, reason: null };

export interface CollaborationEventHandlers {
  /** Replace the whole scene (remote undo/redo, clear). */
  onScene?: (elements: Shape[]) => void;
  /**
   * Initial room hydration (`canvas-state-sync` on join). Kept separate from
   * `onScene` so the editor can refuse an empty hydration that would blank a
   * board it already loaded from the database.
   */
  onInitialScene?: (elements: Shape[]) => void;
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
  /**
   * Whether the server is managing to keep this room's drawing, and why not.
   * The object identity only changes when the answer does, so a consumer can
   * treat a new one as news.
   */
  scenePersistence: ScenePersistence;
  /**
   * The label over your own cursor. Persisted, so it is the same name next time
   * — and editable, which is why it is state here rather than a value the socket
   * effect mints on mount.
   */
  userName: string;
  /**
   * Rename yourself. Returns false when the input held nothing usable, so the
   * caller can keep the field open instead of committing a blank label.
   */
  setUserName: (value: string) => boolean;
  users: User[];
  cursors: CursorPositionsMap;
  remoteInProgress: Record<string, Shape>;
  shareableLink: string;
  linkCopied: boolean;
  /** Resolves false when the clipboard is unavailable or refused the write. */
  copyShareableLink: () => Promise<boolean>;
  sendCursor: (point: Point) => void;
  sendScene: (elements: Shape[]) => void;
  sendElements: (elements: Shape[]) => void;
  sendDeletions: (ids: string[]) => void;
  sendPendingElement: (element: Shape | null) => void;
  setEventHandlers: (handlers: CollaborationEventHandlers) => void;
}

const CollaborationContext = createContext<
  CollaborationContextValue | undefined
>(undefined);

export function useCollaborationContext(): CollaborationContextValue {
  const context = useContext(CollaborationContext);

  if (!context) {
    throw new Error(
      "useCollaborationContext must be used within a CollaborationContextProvider",
    );
  }

  return context;
}

export const CollaborationContextProvider: React.FC<{
  /**
   * The board being edited, provided by the /board/[id] route. `null` on the
   * local canvas at `/`: the context still exists (so `Canvas` can call the
   * hook unconditionally) but no socket is opened.
   */
  roomId: string | null;
  children: React.ReactNode;
}> = ({ roomId: roomIdProp, children }) => {
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef<CollaborationEventHandlers>({});

  const [isClient, setIsClient] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [cursors, setCursors] = useState<CursorPositionsMap>({});
  const [remoteInProgress, setRemoteInProgress] = useState<
    Record<string, Shape>
  >({});
  const [shareableLink, setShareableLink] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [userName, setUserNameState] = useState("");
  const [scenePersistence, setScenePersistence] =
    useState<ScenePersistence>(PERSISTENCE_UNKNOWN);

  const identityRef = useRef<{
    roomId: string;
    userId: string;
    tag: string;
  } | null>(null);
  /**
   * The live display name, read through to localStorage on first use.
   *
   * A ref rather than the `userName` state because the socket effect reads it:
   * depending on the state would tear the connection down and reconnect on every
   * rename, which drops everyone's cursors and re-runs hydration for a change of
   * label. The name travels over the wire instead (`update-user-name`).
   */
  const userNameRef = useRef<string | null>(null);
  const lastCursorSentRef = useRef(0);
  const lastPendingSentRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  /** Never called during SSR — every caller is inside an effect or a handler. */
  const currentUserName = useCallback((): string => {
    if (userNameRef.current === null) {
      userNameRef.current = readUserName();
    }
    return userNameRef.current;
  }, []);

  useEffect(() => setIsClient(true), []);

  /*
   * Your own name is yours whether or not there is a room: it is the label the
   * next session you start will carry, so the menu can offer it on the local
   * canvas too.
   */
  useEffect(() => {
    if (isClient) {
      setUserNameState(currentUserName());
    }
  }, [currentUserName, isClient]);

  const setEventHandlers = useCallback(
    (handlers: CollaborationEventHandlers) => {
      handlersRef.current = handlers;
    },
    [],
  );

  useEffect(() => {
    if (!isClient || !roomIdProp) {
      return;
    }

    const currentUserId = readUserId();
    const tag = currentUserName();

    const currentRoomId = roomIdProp;

    identityRef.current = { roomId: currentRoomId, userId: currentUserId, tag };
    setUserId(currentUserId);
    setRoomId(currentRoomId);
    setShareableLink(`${window.location.origin}/board/${currentRoomId}`);
    // Whatever the last room was managing to save says nothing about this one.
    setScenePersistence(PERSISTENCE_UNKNOWN);

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
      // `currentUserName()` rather than the captured `tag`: a reconnect after a
      // rename must rejoin under the new name, not the one this effect started
      // with.
      socket.emit("join-room", {
        roomId: currentRoomId,
        userId: currentUserId,
        userTag: currentUserName(),
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
      const incoming = Array.isArray(data?.users) ? data.users : [];
      setUsers(incoming);

      /*
       * The roster is authoritative about who is here and what they are called,
       * and it is the only notice of a departure the server sends: a peer who
       * closes their tab is simply absent from the next one.
       *
       * So somebody who renames is relabelled over their cursor now rather than
       * at their next pointer move, and somebody who left takes their leftovers
       * with them. Their cursor would eventually go on its own once it went
       * stale, but the shape they were part-way through drawing carries no
       * timestamp: without this it sits on everyone else's canvas until each of
       * them reconnects.
       */
      const tagById = new Map(incoming.map((user) => [user.id, user.tag]));

      setCursors((current) => {
        let changed = false;
        const next: CursorPositionsMap = {};

        for (const [id, cursor] of Object.entries(current)) {
          if (!tagById.has(id)) {
            changed = true;
            continue;
          }

          const tag = tagById.get(id);
          // A roster row with no name is not a reason to unlabel a cursor.
          if (!tag || tag === cursor.tag) {
            next[id] = cursor;
            continue;
          }

          changed = true;
          next[id] = { ...cursor, tag };
        }

        return changed ? next : current;
      });

      setRemoteInProgress((current) => {
        const departed = Object.keys(current).filter(
          (id) => !tagById.has(id),
        );
        if (departed.length === 0) {
          return current;
        }

        const next = { ...current };
        for (const id of departed) {
          delete next[id];
        }
        return next;
      });
    });

    /*
     * The server writes the room's scene, so only it knows when that stopped
     * working — the board deleted from the gallery in another tab, a scene too
     * large for the column, Postgres unreachable. It says so after every write
     * attempt; identity is the change signal, so a consumer re-renders when the
     * answer changes rather than every three seconds while somebody draws.
     *
     * Not cleared on disconnect, unlike the roster: a deleted board is still
     * deleted, and losing the connection is reported on its own.
     */
    socket.on(
      "scene-persistence",
      (data: { durable?: unknown; reason?: unknown }) => {
        const durable = data?.durable === true;
        const reason =
          typeof data?.reason === "string" &&
          PERSISTENCE_REASONS.includes(data.reason)
            ? (data.reason as ScenePersistenceReason)
            : null;
        setScenePersistence((current) =>
          current.durable === durable && current.reason === reason
            ? current
            : { durable, reason },
        );
      },
    );

    socket.on(
      "canvas-state-sync",
      (data: { userId?: string; shapes?: unknown }) => {
        if (isSelf(data?.userId)) {
          return;
        }
        const incoming = restoreElements(data?.shapes);
        const handlers = handlersRef.current;
        (handlers.onInitialScene ?? handlers.onScene)?.(incoming);
      },
    );

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

    socket.on(
      "shape-in-progress",
      (data: { userId?: string; shape?: unknown }) => {
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
      },
    );

    socket.on(
      "drawing-state",
      (data: { userId?: string; isDrawing?: boolean }) => {
        if (isSelf(data?.userId) || data?.isDrawing !== false) {
          return;
        }

        setRemoteInProgress((current) => {
          const next = { ...current };
          delete next[data.userId as string];
          return next;
        });
      },
    );

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
  }, [currentUserName, isClient, roomIdProp]);

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

  const emit = useCallback(
    (event: string, payload: Record<string, unknown>) => {
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
    },
    [],
  );

  /**
   * Make an already-stored name the live one.
   *
   * Three places have to agree: the state the menu renders, the identity the
   * cursor messages are stamped with, and the server's roster. The local roster
   * row is patched optimistically because the server echo only arrives if there
   * is a room — on the local canvas at `/` there is no socket at all, and the
   * name still has to stick.
   */
  const adoptUserName = useCallback(
    (stored: string) => {
      userNameRef.current = stored;
      setUserNameState(stored);

      const identity = identityRef.current;
      if (identity) {
        identity.tag = stored;
        setUsers((current) =>
          current.map((user) =>
            user.id === identity.userId ? { ...user, tag: stored } : user,
          ),
        );
      }

      emit("update-user-name", { userTag: stored });
    },
    [emit],
  );

  /** Rename yourself. Persists first, so a refused write changes nothing. */
  const setUserName = useCallback(
    (value: string): boolean => {
      const stored = writeUserName(value);
      if (!stored) {
        return false;
      }
      adoptUserName(stored);
      return true;
    },
    [adoptUserName],
  );

  /*
   * Renaming yourself in another tab renames you here. Both tabs read the name
   * once and then held it in a ref, so before this the two disagreed for as long
   * as they stayed open — and whichever one you next renamed overwrote the other.
   * A cleared entry is ignored rather than treated as a rename: minting a fresh
   * random name for someone who has one would be a stranger outcome.
   */
  useEffect(() => {
    if (!isClient) {
      return;
    }

    return subscribeToStorageKey(USER_NAME_KEY, (value) => {
      const stored = normalizeUserName(value ?? "");
      if (!stored || stored === userNameRef.current) {
        return;
      }
      adoptUserName(stored);
    });
  }, [adoptUserName, isClient]);

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

  /**
   * Resolves with whether the link reached the clipboard, so the caller can say
   * so. `navigator.clipboard` is absent over plain HTTP and can reject when the
   * document is not focused, and a copy that silently did nothing is worse than
   * one that admits it.
   */
  const copyShareableLink = useCallback(async (): Promise<boolean> => {
    if (!shareableLink || !navigator.clipboard) {
      return false;
    }

    try {
      await navigator.clipboard.writeText(shareableLink);
    } catch (error) {
      console.warn("Could not copy the share link:", error);
      return false;
    }

    setLinkCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => setLinkCopied(false), 2000);
    return true;
  }, [shareableLink]);

  const value = useMemo<CollaborationContextValue>(
    () => ({
      isConnected,
      isEnabled: isClient,
      roomId,
      userId,
      scenePersistence,
      userName,
      setUserName,
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
      scenePersistence,
      sendCursor,
      sendDeletions,
      sendElements,
      sendPendingElement,
      sendScene,
      setEventHandlers,
      setUserName,
      shareableLink,
      userId,
      userName,
      users,
    ],
  );

  return (
    <CollaborationContext.Provider value={value}>
      {children}
    </CollaborationContext.Provider>
  );
};
