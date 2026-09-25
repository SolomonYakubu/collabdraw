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
import { isFreehandShape } from "../types/shapes";
import type { CursorPositionsMap, User } from "../types/collaboration";
import { getPointsBounds, restoreElements } from "../services/canvas/elements";
import {
  USER_NAME_KEY,
  normalizeUserName,
  readUserId,
  readUserName,
  writeUserName,
} from "../services/collaboration/identity";
import { subscribeToStorageKey } from "../services/storageSync";

const CURSOR_THROTTLE_MS = 50;
export const PENDING_THROTTLE_MS = 40;
const STALE_CURSOR_MS = 10_000;

/**
 * Socket.IO reconnection attempts against one server before the client rotates
 * to the next one. Kept short so a dead host is abandoned in a few seconds; the
 * loop alternates between the configured servers, so an outage longer than one
 * server's attempts is still covered. A deployment with a single URL keeps the
 * historical, longer retry instead — there is nothing to fail over to.
 */
const FAILOVER_RECONNECT_ATTEMPTS = 3;
const FAILOVER_RECONNECT_DELAY_MS = 500;
const FAILOVER_RECONNECT_DELAY_MAX_MS = 2000;

/**
 * How long a burst of incremental element updates is folded into one message.
 *
 * A drag applies its transform on every pointer move, and a pointing device
 * reports far faster than a screen paints — 120Hz trackpads are ordinary. Without
 * coalescing that is a `canvas-update` per move, each fanned out to everybody in
 * the room. The first update of a burst still goes out at once (a peer's view
 * should start moving with no added latency); everything after it accumulates
 * until the window closes, and what is flushed is the latest state per element.
 */
export const ELEMENT_COALESCE_MS = 33;

/**
 * How long a burst of mid-gesture previews is folded into one message.
 *
 * The same shape of problem as the cursor: a drag applies on every pointer move,
 * but a position that has already been superseded is worth less than the message
 * behind it. So previews travel volatile — dropped rather than queued when the
 * link backs up — and the window is a frame at 60Hz rather than the committed
 * `ELEMENT_COALESCE_MS`, because a preview a frame late is the lag this channel
 * exists to remove and a dropped one costs only smoothness.
 */
export const TRANSIENT_COALESCE_MS = 16;

/**
 * Full freehand snapshots between incremental ones. A delta dropped by a volatile
 * send would otherwise leave a permanent hole in the preview; re-anchoring every
 * so often bounds what a drop costs to well under a second of stroke.
 */
export const FREEHAND_FULL_EVERY = 20;

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
  /**
   * The host's pointer, delivered once to somebody who has just joined, so the
   * editor can centre its view on it. Called at most once per session, and only
   * for a client that joined an already-occupied room.
   */
  onHostCursor?: (point: Point) => void;
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
  /**
   * A mid-gesture movement preview: relayed droppable, so a backed-up peer
   * drops it rather than queueing it ahead of live messages. The commit on
   * release goes through `sendElements`, which settles the element for good.
   */
  sendTransientElements: (elements: Shape[]) => void;
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

  /*
   * The socket servers to try, primary first. The backup is optional; with one
   * URL the client behaves exactly as before and just retries it. Read here
   * rather than at module load so a test (or a rebuilt env) is not stuck with
   * whatever was present when the bundle was first evaluated.
   *
   * `NEXT_PUBLIC_*` is inlined at build time, so both must be set for the
   * deployment that serves this bundle — not only on the socket servers.
   */
  const socketUrls = useMemo(() => {
    const primary =
      process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001";
    const backup = process.env.NEXT_PUBLIC_SOCKET_URL_BACKUP || "";
    return Array.from(new Set([primary, backup].filter(Boolean)));
  }, []);
  /** Which of `socketUrls` is in use; a failed server advances it. */
  const [socketUrlIndex, setSocketUrlIndex] = useState(0);
  const socketUrl = socketUrls[socketUrlIndex % socketUrls.length];

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
  /** Incremental updates waiting to be folded into one `canvas-update`. */
  const pendingElementsRef = useRef(new Map<string, Shape>());
  const elementTimerRef = useRef<number | null>(null);
  /**
   * Mid-gesture movement previews waiting to be folded into one volatile
   * `canvas-update`. Kept apart from `pendingElementsRef` so a queued preview can
   * never be flushed onto the reliable path, or a committed element onto the
   * droppable one.
   */
  const pendingTransientRef = useRef(new Map<string, Shape>());
  const transientTimerRef = useRef<number | null>(null);
  /** Where the last in-progress freehand send stopped, per stroke. */
  const lastPendingPointsRef = useRef<{
    id: string;
    sentPoints: number;
    deltas: number;
  } | null>(null);
  /**
   * Your own latest pointer, in world coordinates, kept even when the throttle
   * swallows a send: it is what the room's host re-announces when somebody
   * joins, and the last known position is the right one for that.
   */
  const lastCursorRef = useRef<Point | null>(null);
  /** The ids seen in the roster, so a join can be told from a rename. */
  const knownUserIdsRef = useRef<Set<string>>(new Set());
  /** The host this client joined behind, while waiting for their pointer. */
  const pendingHostIdRef = useRef<string | null>(null);
  /** Whether the one-time centring on the host has already happened. */
  const hostCentredRef = useRef(false);
  /** Everyone's latest pointer, so a late roster can still find the host's. */
  const cursorByUserRef = useRef<Record<string, Point>>({});

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

  // The provider going away must not leave a coalescing timer behind; what it
  // would send is stale, and the emit it reaches is a no-op by then anyway.
  useEffect(
    () => () => {
      if (elementTimerRef.current !== null) {
        window.clearTimeout(elementTimerRef.current);
        elementTimerRef.current = null;
      }
      pendingElementsRef.current.clear();
      if (transientTimerRef.current !== null) {
        window.clearTimeout(transientTimerRef.current);
        transientTimerRef.current = null;
      }
      pendingTransientRef.current.clear();
    },
    [],
  );

  /*
   * A new room is a new join: the roster has not been seen, there is nobody to
   * follow yet, and the one-time centring is available again. The stored cursor
   * is from the board being left, so it is not a position to announce.
   *
   * Keyed on the room, not on the socket, so a failover to the other server
   * does not re-run the join handshake — the host has not changed and the view
   * must not jump again.
   */
  useEffect(() => {
    knownUserIdsRef.current = new Set();
    pendingHostIdRef.current = null;
    hostCentredRef.current = false;
    cursorByUserRef.current = {};
    lastCursorRef.current = null;
  }, [roomIdProp]);

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

    const hasBackup = socketUrls.length > 1;

    const socket = io(socketUrl, {
      query: { roomId: currentRoomId, userId: currentUserId, userTag: tag },
      // Shorter when there is somewhere to fail over to; unchanged for a
      // single-server deployment.
      reconnectionAttempts: hasBackup ? FAILOVER_RECONNECT_ATTEMPTS : 10,
      reconnectionDelay: hasBackup ? FAILOVER_RECONNECT_DELAY_MS : 1000,
      reconnectionDelayMax: FAILOVER_RECONNECT_DELAY_MAX_MS,
      transports: ["websocket", "polling"],
      timeout: 10_000,
      // A fresh Manager per attempt, so a server abandoned earlier is not
      // reused out of socket.io's per-URL cache when the rotation comes back
      // round to it.
      forceNew: true,
    });

    socketRef.current = socket;

    /*
     * This server has run out of reconnection attempts. Advance to the next URL
     * and let the effect re-run with it; the cleanup below closes this socket
     * first, so the two never overlap. With a single configured server there is
     * nowhere to go, and the historical behaviour of stopping is kept.
     */
    socket.io.on("reconnect_failed", () => {
      if (!hasBackup) {
        return;
      }
      setSocketUrlIndex((index) => index + 1);
    });

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

      /*
       * The host is the first name in the roster, which the server orders by
       * when each person joined. Two things follow from that.
       *
       * If I am the host, somebody new joined behind me and cannot see where I
       * am, so I re-announce my pointer for them to centre on. An ordinary
       * cursor send will not do: it is throttled, and a room is idle exactly
       * when a newcomer arrives.
       *
       * If I am the newcomer, the first name that is not mine is the host, and
       * their next pointer centres my view. The pointer may already have
       * arrived — the two messages can cross instances and reorder — in which
       * case it is used now.
       */
      const hostId = incoming[0]?.id;
      const sawNewPeer = incoming.some(
        (user) => user.id !== currentUserId && !knownUserIdsRef.current.has(user.id),
      );
      knownUserIdsRef.current = new Set(incoming.map((user) => user.id));

      if (sawNewPeer && hostId === currentUserId) {
        const point = lastCursorRef.current;
        if (point) {
          socket.emit("announce-cursor", {
            roomId: currentRoomId,
            userId: currentUserId,
            x: point.x,
            y: point.y,
            tag: currentUserName(),
          });
        }
      }

      if (
        pendingHostIdRef.current === null &&
        !hostCentredRef.current &&
        hostId &&
        hostId !== currentUserId
      ) {
        pendingHostIdRef.current = hostId;
        const known = cursorByUserRef.current[hostId];
        if (known) {
          hostCentredRef.current = true;
          handlersRef.current.onHostCursor?.(known);
        }
      }
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

        // The first pointer from the host is the join handshake: centre the
        // view on it, once, then leave navigation alone.
        const from = data.userId as string;
        cursorByUserRef.current[from] = {
          x: data.x as number,
          y: data.y as number,
        };

        if (pendingHostIdRef.current === from && !hostCentredRef.current) {
          hostCentredRef.current = true;
          handlersRef.current.onHostCursor?.(cursorByUserRef.current[from]);
        }
      },
    );

    socket.on(
      "shape-in-progress",
      (data: {
        userId?: string;
        shape?: unknown;
        pointsOffset?: unknown;
      }) => {
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

          /*
           * A freehand stroke arrives in increments against the copy already on
           * screen, so a long scribble costs two numbers a tick rather than the
           * whole stroke. An increment only appends when what we hold is exactly
           * the base the sender thinks we hold; otherwise — the base snapshot was
           * dropped by a volatile send, or this peer joined mid-stroke — it is
           * ignored, and the next full snapshot or the committed element is
           * authoritative.
           */
          const offset =
            typeof data?.pointsOffset === "number" &&
            Number.isFinite(data.pointsOffset)
              ? data.pointsOffset
              : 0;

          if (offset > 0) {
            const base = current[data.userId as string];
            if (
              base &&
              base.id === element.id &&
              isFreehandShape(base) &&
              isFreehandShape(element) &&
              base.points.length === offset
            ) {
              const points = [...base.points, ...element.points];
              // The increment arrived describing only its own points, so the
              // box it carries no longer covers the stroke; the renderer culls
              // on that box, so it has to grow with the stroke.
              const box = getPointsBounds(points);
              return {
                ...current,
                [data.userId as string]: {
                  ...element,
                  points,
                  ...box,
                  isInProgress: true,
                },
              };
            }
            return current;
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
      // `disconnect()` also tears the Manager down (`skipReconnect`), so a
      // socket being replaced by a failover cannot reconnect behind the new one.
      socket.disconnect();
      socketRef.current = null;
    };
  }, [currentUserName, isClient, roomIdProp, socketUrl, socketUrls]);

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
    (
      event: string,
      payload: Record<string, unknown>,
      { volatile = false }: { volatile?: boolean } = {},
    ) => {
      const socket = socketRef.current;
      const identity = identityRef.current;

      if (!socket?.connected || !identity) {
        return;
      }

      const envelope = {
        roomId: identity.roomId,
        userId: identity.userId,
        ...payload,
      };

      // A volatile send is dropped rather than queued when the link is backed
      // up: a cursor position or a half-drawn stroke from a moment ago is worth
      // less than the messages stuck behind it.
      if (volatile) {
        socket.volatile.emit(event, envelope);
        return;
      }

      socket.emit(event, envelope);
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
      // Remembered before the throttle can swallow the send: this is the
      // position the host re-announces to a newcomer.
      lastCursorRef.current = point;

      const now = Date.now();
      if (now - lastCursorSentRef.current < CURSOR_THROTTLE_MS) {
        return;
      }
      lastCursorSentRef.current = now;

      // Volatile: a cursor position that missed its turn is stale the moment the
      // next one is due, and queuing it would delay every message behind it.
      emit("cursor-position", { x: point.x, y: point.y, tag: identityRef.current?.tag }, { volatile: true });
    },
    [emit],
  );

  /** Whatever accumulated during the coalescing window, as one partial update. */
  const flushElements = useCallback(() => {
    if (elementTimerRef.current !== null) {
      window.clearTimeout(elementTimerRef.current);
      elementTimerRef.current = null;
    }

    const pending = pendingElementsRef.current;
    if (pending.size === 0) {
      return;
    }
    pendingElementsRef.current = new Map();
    emit("canvas-update", { shapes: [...pending.values()], isPartial: true });
  }, [emit]);

  /** The accumulated preview frames, as one volatile partial update. */
  const flushTransient = useCallback(() => {
    if (transientTimerRef.current !== null) {
      window.clearTimeout(transientTimerRef.current);
      transientTimerRef.current = null;
    }

    const pending = pendingTransientRef.current;
    if (pending.size === 0) {
      return;
    }
    pendingTransientRef.current = new Map();
    emit(
      "canvas-update",
      { shapes: [...pending.values()], isPartial: true, isTransient: true },
      { volatile: true },
    );
  }, [emit]);

  /**
   * Forget queued previews, because something authoritative now covers them.
   *
   * Without this a preview queued a frame before the commit would flush after
   * it — both channels share one TCP connection, so the peer would apply the
   * older position last and the shape would snap back on release. The timer is
   * cancelled with the last id, so an emptied queue schedules nothing.
   */
  const discardTransient = useCallback((ids?: Iterable<string>) => {
    const pending = pendingTransientRef.current;
    if (pending.size === 0) {
      return;
    }

    if (ids) {
      for (const id of ids) {
        pending.delete(id);
      }
    } else {
      pending.clear();
    }

    if (pending.size === 0 && transientTimerRef.current !== null) {
      window.clearTimeout(transientTimerRef.current);
      transientTimerRef.current = null;
    }
  }, []);

  const sendScene = useCallback(
    (elements: Shape[]) => {
      // A full scene replaces everything a peer holds, so an incremental update
      // still in flight would only re-apply an older element on top of it — and a
      // preview is an even staler version of the same thing.
      if (elementTimerRef.current !== null) {
        window.clearTimeout(elementTimerRef.current);
        elementTimerRef.current = null;
      }
      pendingElementsRef.current.clear();
      discardTransient();

      emit("canvas-update", { shapes: elements, fullUpdate: true });
    },
    [discardTransient, emit],
  );

  const sendElements = useCallback(
    (elements: Shape[]) => {
      if (elements.length === 0) {
        return;
      }

      // A committed element supersedes every preview of it, including one queued
      // for the next frame.
      discardTransient(elements.map((element) => element.id));

      const pending = pendingElementsRef.current;
      for (const element of elements) {
        pending.set(element.id, element);
      }

      if (elementTimerRef.current !== null) {
        // A trailing send is already scheduled; this call only refreshed what it
        // will carry.
        return;
      }

      // Leading edge: the first update of a burst goes out at once.
      flushElements();
      elementTimerRef.current = window.setTimeout(() => {
        elementTimerRef.current = null;
        flushElements();
      }, ELEMENT_COALESCE_MS);
    },
    [discardTransient, flushElements],
  );

  /**
   * A mid-gesture preview. Same leading-edge-plus-window shape as
   * `sendElements`, but volatile: a frame the link could not carry is dropped
   * rather than queued ahead of the frame after it.
   */
  const sendTransientElements = useCallback(
    (elements: Shape[]) => {
      if (elements.length === 0) {
        return;
      }

      const pending = pendingTransientRef.current;
      for (const element of elements) {
        pending.set(element.id, element);
      }

      if (transientTimerRef.current !== null) {
        // A trailing send is already scheduled; this call only refreshed it.
        return;
      }

      flushTransient();
      transientTimerRef.current = window.setTimeout(() => {
        transientTimerRef.current = null;
        flushTransient();
      }, TRANSIENT_COALESCE_MS);
    },
    [flushTransient],
  );

  const sendDeletions = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) {
        return;
      }
      // An element erased while its update is still queued must not be
      // resurrected by that queue when it flushes — and the same goes for a
      // preview of it.
      discardTransient(ids);
      for (const id of ids) {
        pendingElementsRef.current.delete(id);
      }
      emit("canvas-update", { deletedShapeIds: ids, isPartial: true });
    },
    [discardTransient, emit],
  );

  const sendPendingElement = useCallback(
    (element: Shape | null) => {
      if (!element) {
        emit("drawing-state", { isDrawing: false });
        lastPendingSentRef.current = 0;
        lastPendingPointsRef.current = null;
        return;
      }

      const now = Date.now();
      if (now - lastPendingSentRef.current < PENDING_THROTTLE_MS) {
        return;
      }
      lastPendingSentRef.current = now;

      /*
       * A freehand stroke grows by two numbers a move, but was sent whole — so a
       * long scribble paid for the entire stroke again every 40ms, O(n²) bytes
       * over the gesture. Past the first tick only the points added since the
       * last send go out, tagged with how many the receiver should already hold;
       * and every so often a full snapshot re-anchors the preview, so a delta
       * dropped by a volatile send costs a fraction of a second rather than the
       * rest of the stroke. Everything else has no array to grow: send it whole.
       */
      if (isFreehandShape(element)) {
        const total = element.points.length;
        const last = lastPendingPointsRef.current;
        const continuing = last !== null && last.id === element.id;

        if (
          continuing &&
          last.sentPoints > 0 &&
          total > last.sentPoints &&
          last.deltas < FREEHAND_FULL_EVERY
        ) {
          emit(
            "shape-in-progress",
            {
              shape: {
                ...element,
                points: element.points.slice(last.sentPoints),
                isInProgress: true,
              },
              pointsOffset: last.sentPoints,
            },
            { volatile: true },
          );
          lastPendingPointsRef.current = {
            id: element.id,
            sentPoints: total,
            deltas: last.deltas + 1,
          };
          return;
        }

        emit(
          "shape-in-progress",
          { shape: { ...element, isInProgress: true } },
          { volatile: true },
        );
        lastPendingPointsRef.current = {
          id: element.id,
          sentPoints: total,
          deltas: 0,
        };
        return;
      }

      emit(
        "shape-in-progress",
        { shape: { ...element, isInProgress: true } },
        { volatile: true },
      );
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
      sendTransientElements,
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
      sendTransientElements,
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
