/**
 * One socket, one room store, and a record of everything the server sent.
 *
 * The three handler modules are registered the same way — `register(io, socket)`
 * hangs listeners off a socket — so a test only needs a way to fire an event and
 * a way to read what went out. That is what this builds.
 *
 * The awkward part is module loading, and it is why this file exists rather than
 * a `vi.mock` in each test. Every handler is CommonJS: it `require`s `../state`
 * (which exports one shared store) and destructures `../roomState`'s functions at
 * load time. So the fake store has to be in place *before* the handler loads, and
 * a stale singleton has to be evicted between tests, or one test's room membership
 * decides another test's answer. Faking `roomState` also keeps Redis and Postgres
 * out of it entirely.
 */
import { createRequire } from "node:module";
import { vi } from "vitest";

const nodeRequire = createRequire(import.meta.url);

const STATE_PATH = nodeRequire.resolve("../../state.js");
const ROOM_STATE_PATH = nodeRequire.resolve("../../roomState.js");
const HANDLER_PATHS = {
  canvas: nodeRequire.resolve("../../handlers/canvasHandler.js"),
  cursor: nodeRequire.resolve("../../handlers/cursorHandler.js"),
  room: nodeRequire.resolve("../../handlers/roomHandler.js"),
};

/**
 * @param {object} options
 * @param {"canvas" | "cursor" | "room"} options.handler which module to register.
 * @param {object} [options.roomState] overrides for the faked persistence layer;
 *   the defaults are "nothing stored anywhere".
 * @param {string} [options.socketId]
 */
export const createHarness = ({
  handler,
  roomState = {},
  socketId = "socket-1",
} = {}) => {
  const roomStateFake = {
    scheduleFlush: vi.fn(),
    flushRoomNow: vi.fn(async () => {}),
    loadCanvasState: vi.fn(async () => null),
    loadBoardScene: vi.fn(async () => null),
    ...roomState,
  };

  nodeRequire.cache[ROOM_STATE_PATH] = {
    id: ROOM_STATE_PATH,
    filename: ROOM_STATE_PATH,
    loaded: true,
    exports: roomStateFake,
  };

  // A fresh store, then the handler that closes over it.
  delete nodeRequire.cache[STATE_PATH];
  const store = nodeRequire("../../state.js");
  delete nodeRequire.cache[HANDLER_PATHS[handler]];
  const register = nodeRequire(HANDLER_PATHS[handler]);

  /** Everything the server sent, in order: `{ to, event, payload }`. */
  const emitted = [];
  const listeners = new Map();

  /** What `io.sockets.adapter.rooms` answers — socket ids per room. */
  const rooms = new Map();

  /**
   * `null` means no working Redis adapter, so `fetchSockets()` throws and the
   * handlers fall back to the local store. That is the single-instance
   * deployment, and the default.
   */
  let clusterSockets = null;

  const record = (to) => ({
    emit: (event, payload) => emitted.push({ to, event, payload }),
  });

  const socket = {
    id: socketId,
    data: {},
    on: (event, listener) => listeners.set(event, listener),
    emit: (event, payload) => emitted.push({ to: "self", event, payload }),
    to: (room) => record(`room:${room}`),
    join: vi.fn((room) => {
      rooms.set(room, new Set([...(rooms.get(room) ?? []), socketId]));
    }),
    leave: vi.fn((room) => {
      rooms.get(room)?.delete(socketId);
    }),
  };

  const io = {
    to: (target) => record(target),
    in: (roomId) => ({
      fetchSockets: async () => {
        if (clusterSockets === null) {
          throw new Error("no redis adapter in this deployment");
        }
        return clusterSockets.filter(
          (s) => !s.rooms || s.rooms.includes(roomId),
        );
      },
    }),
    sockets: { adapter: { rooms } },
  };

  register(io, socket);

  return {
    store,
    socket,
    io,
    emitted,
    roomState: roomStateFake,

    /** Fire a client event. Returns the handler's promise when it has one. */
    fire: (event, ...args) => listeners.get(event)?.(...args),

    /** Which events the module actually listens for. */
    events: () => [...listeners.keys()],

    /** Everything sent for one event name. */
    sent: (event) => emitted.filter((e) => e.event === event),

    /** Turn the cluster-wide roster on: `[{ data: { userId, userTag } }]`. */
    withClusterSockets: (sockets) => {
      clusterSockets = sockets;
    },

    /** Seed the socket ids the adapter believes are in a room. */
    withRoomMembers: (roomId, ids) => {
      rooms.set(roomId, new Set(ids));
    },

    /** A Vitest worker is shared between files; leave no singletons behind. */
    cleanup: () => {
      delete nodeRequire.cache[ROOM_STATE_PATH];
      delete nodeRequire.cache[STATE_PATH];
      delete nodeRequire.cache[HANDLER_PATHS[handler]];
    },
  };
};
