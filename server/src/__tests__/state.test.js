/**
 * The room store: who is in a room, and what has been drawn in it.
 *
 * Everything here is in memory and shared by every socket in the process, which
 * is why it is worth testing in isolation — a bug in the merge does not throw,
 * it just loses somebody's shape and shows up as "my rectangle disappeared".
 *
 * Two seams shape the harness. `state.js` exports one shared instance, so a test
 * that wants an empty store has to reload the module; and `removeUserBySocketId`
 * reaches for `roomState` lazily, at call time, to force a durable flush before
 * an empty room's scene is dropped — so a fake planted in the require cache
 * before the call is what a test sees, and the real Redis/Postgres chain never
 * loads.
 */
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodeRequire = createRequire(import.meta.url);

const STATE_PATH = nodeRequire.resolve("../state.js");
const ROOM_STATE_PATH = nodeRequire.resolve("../roomState.js");

const { MAX_SHAPES_PER_ROOM } = nodeRequire("../validation.js");

/** The forced flush an emptying room performs; asserted, never real. */
let flushRoomNow;

/**
 * A store with nothing in it. The module exports `new RoomStore()`, so this is
 * the only way to get one — and the cache entry is dropped again afterwards,
 * because a Vitest worker is shared between test files.
 */
const freshStore = () => {
  delete nodeRequire.cache[STATE_PATH];
  return nodeRequire("../state.js");
};

const shape = (id, extra = {}) => ({ id, tool: "Square", x: 0, y: 0, ...extra });

let store;

beforeEach(() => {
  flushRoomNow = vi.fn(async () => {});
  // Planted before `state.js` loads, so its lazy `require("./roomState")`
  // resolves here instead of opening a Redis connection.
  nodeRequire.cache[ROOM_STATE_PATH] = {
    id: ROOM_STATE_PATH,
    filename: ROOM_STATE_PATH,
    loaded: true,
    exports: { flushRoomNow, scheduleFlush: () => {} },
  };
  store = freshStore();
});

afterEach(() => {
  delete nodeRequire.cache[ROOM_STATE_PATH];
  delete nodeRequire.cache[STATE_PATH];
  vi.restoreAllMocks();
});

describe("presence", () => {
  it("has no users in a room nobody has joined", () => {
    expect(store.getRoomUsers("room1")).toEqual([]);
    expect(store.getUserInRoom("room1", "user1")).toBeNull();
  });

  it("seats a user and remembers which room their socket is in", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");

    expect(store.getRoomUsers("room1")).toEqual([{ id: "user1", tag: "Ada" }]);
    expect(store.userRooms.get("socket1")).toBe("room1");
  });

  it("does not put socket ids in the roster it broadcasts", () => {
    // `active-users` goes to every peer; a socket id is the address the server
    // uses to talk to one client, and nobody else's business.
    store.addUserToRoom("room1", "user1", "Ada", "socket1");

    for (const user of store.getRoomUsers("room1")) {
      expect(Object.keys(user).sort()).toEqual(["id", "tag"]);
    }
  });

  it("keeps rooms apart", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");
    store.addUserToRoom("room2", "user2", "Grace", "socket2");

    expect(store.getRoomUsers("room1")).toEqual([{ id: "user1", tag: "Ada" }]);
    expect(store.getRoomUsers("room2")).toEqual([{ id: "user2", tag: "Grace" }]);
  });

  it("gives a reconnecting user their seat back rather than a second one", () => {
    // Same identity, new socket: a dropped connection must not leave a ghost in
    // the roster, because the roster is what everyone sees.
    store.addUserToRoom("room1", "user1", "Ada", "socket1");
    store.addUserToRoom("room1", "user1", "Ada", "socket2");

    expect(store.getRoomUsers("room1")).toHaveLength(1);
    expect(store.getUserInRoom("room1", "user1").socketId).toBe("socket2");
  });

  it("finds a user by id, and answers null for one who is not there", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");

    expect(store.getUserInRoom("room1", "user1")).toEqual({
      id: "user1",
      tag: "Ada",
      socketId: "socket1",
    });
    expect(store.getUserInRoom("room1", "nobody")).toBeNull();
    expect(store.getUserInRoom("no-such-room", "user1")).toBeNull();
  });
});

describe("renaming", () => {
  it("reports a real change, so the roster is rebroadcast", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");

    expect(store.setUserTag("room1", "user1", "Ada L.")).toBe(true);
    expect(store.getRoomUsers("room1")).toEqual([
      { id: "user1", tag: "Ada L." },
    ]);
  });

  it("reports no change for the same tag, so the broadcast is skipped", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");

    expect(store.setUserTag("room1", "user1", "Ada")).toBe(false);
  });

  it("reports no change for somebody who is not in the room", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");

    expect(store.setUserTag("room1", "stranger", "Ada L.")).toBe(false);
    expect(store.setUserTag("no-such-room", "user1", "Ada L.")).toBe(false);
  });
});

describe("leaving", () => {
  it("has nothing to say about a socket it never saw", () => {
    expect(store.removeUserBySocketId("socket-unknown")).toEqual({
      roomId: null,
      user: null,
      isEmpty: false,
    });
  });

  it("removes the socket that left, not the room", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");
    store.addUserToRoom("room1", "user2", "Grace", "socket2");

    const result = store.removeUserBySocketId("socket1");

    expect(result.roomId).toBe("room1");
    expect(result.user.id).toBe("user1");
    expect(result.isEmpty).toBe(false);
    expect(store.getRoomUsers("room1")).toEqual([
      { id: "user2", tag: "Grace" },
    ]);
  });

  it("forgets the socket, so a reused id cannot inherit a room", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");
    store.removeUserBySocketId("socket1");

    expect(store.userRooms.has("socket1")).toBe(false);
  });

  it("drops the room and its scene once the last user is out", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");
    store.setCanvasState("room1", [shape("a")]);

    expect(store.removeUserBySocketId("socket1").isEmpty).toBe(true);
    expect(store.activeRooms.has("room1")).toBe(false);
    expect(store.hasCanvasState("room1")).toBe(false);
  });
});

describe("the flush an emptying room forces", () => {
  it("writes the scene durably before dropping it", () => {
    // The debounced flush is up to three seconds away; the scene is about to be
    // deleted from memory. This is the write that decides whether the last
    // minute of a session survives.
    store.addUserToRoom("room1", "user1", "Ada", "socket1");
    store.setCanvasState("room1", [shape("a"), shape("b")]);

    store.removeUserBySocketId("socket1");

    expect(flushRoomNow).toHaveBeenCalledTimes(1);
    const [roomId, scene] = flushRoomNow.mock.calls[0];
    expect(roomId).toBe("room1");
    expect(scene.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("does not write a room that has nothing drawn in it", () => {
    // An empty scene would be a write that can only lose information: the room
    // was joined and left without a mark, and the board may already hold one.
    store.addUserToRoom("room1", "user1", "Ada", "socket1");
    store.setCanvasState("room1", []);

    store.removeUserBySocketId("socket1");

    expect(flushRoomNow).not.toHaveBeenCalled();
  });

  it("does not write while somebody is still drawing in the room", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");
    store.addUserToRoom("room1", "user2", "Grace", "socket2");
    store.setCanvasState("room1", [shape("a")]);

    store.removeUserBySocketId("socket1");

    expect(flushRoomNow).not.toHaveBeenCalled();
  });

  it("returns without waiting for the write", () => {
    // `removeUserBySocketId` is synchronous and the disconnect it serves has a
    // roster to broadcast, so the promise is deliberately not held here —
    // `roomState` tracks it instead, which is how shutdown can drain it.
    store.addUserToRoom("room1", "user1", "Ada", "socket1");
    store.setCanvasState("room1", [shape("a")]);
    flushRoomNow.mockImplementation(() => new Promise(() => {}));

    expect(store.removeUserBySocketId("socket1").isEmpty).toBe(true);
    expect(flushRoomNow).toHaveBeenCalledTimes(1);
  });
});

describe("the cached scene", () => {
  it("knows whether a room has one", () => {
    expect(store.hasCanvasState("room1")).toBe(false);
    expect(store.getCanvasState("room1")).toBeUndefined();

    store.setCanvasState("room1", [shape("a")]);

    expect(store.hasCanvasState("room1")).toBe(true);
    expect(store.getCanvasState("room1")).toHaveLength(1);
  });

  it("caps what one room can hold", () => {
    const tooMany = Array.from({ length: MAX_SHAPES_PER_ROOM + 50 }, (_, i) =>
      shape(`s${i}`),
    );

    store.setCanvasState("room1", tooMany);

    expect(store.getCanvasState("room1")).toHaveLength(MAX_SHAPES_PER_ROOM);
  });
});

describe("merging an update", () => {
  it("replaces the scene when the client says this is all of it", () => {
    store.setCanvasState("room1", [shape("a"), shape("b")]);

    store.updateCanvasState("room1", [shape("c")], null, true);

    expect(store.getCanvasState("room1").map((s) => s.id)).toEqual(["c"]);
  });

  it("replaces on the first update for a room, full or not", () => {
    // There is nothing to merge into, and treating an incremental update as a
    // merge against nothing would be the same answer by a longer road.
    store.updateCanvasState("room1", [shape("a")], null, false);

    expect(store.getCanvasState("room1").map((s) => s.id)).toEqual(["a"]);
  });

  it("updates a shape in place, leaving the order alone", () => {
    // Order is z-order: a shape that jumped to the end of the array on every
    // edit would rise above everything drawn after it.
    store.setCanvasState("room1", [shape("a"), shape("b"), shape("c")]);

    store.updateCanvasState("room1", [shape("b", { x: 99 })], null, false);

    const scene = store.getCanvasState("room1");
    expect(scene.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(scene[1].x).toBe(99);
  });

  it("appends a shape it has not seen before", () => {
    store.setCanvasState("room1", [shape("a")]);

    store.updateCanvasState("room1", [shape("b")], null, false);

    expect(store.getCanvasState("room1").map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("compares ids as strings, so 1 and \"1\" are one shape", () => {
    // Two clients can disagree about the type of an id after a round trip
    // through JSON; a mismatch here would duplicate the shape instead of moving
    // it.
    store.setCanvasState("room1", [shape(1)]);

    store.updateCanvasState("room1", [shape("1", { x: 42 })], null, false);

    const scene = store.getCanvasState("room1");
    expect(scene).toHaveLength(1);
    expect(scene[0].x).toBe(42);
  });

  it("caps the merged scene, so appends cannot grow without end", () => {
    store.setCanvasState(
      "room1",
      Array.from({ length: MAX_SHAPES_PER_ROOM }, (_, i) => shape(`s${i}`)),
    );

    store.updateCanvasState("room1", [shape("one-more")], null, false);

    expect(store.getCanvasState("room1")).toHaveLength(MAX_SHAPES_PER_ROOM);
  });

  it("leaves the scene alone when an update carries no shapes", () => {
    store.setCanvasState("room1", [shape("a")]);

    store.updateCanvasState("room1", [], null, false);
    store.updateCanvasState("room1", null, null, true);

    expect(store.getCanvasState("room1").map((s) => s.id)).toEqual(["a"]);
  });
});

describe("deletions", () => {
  it("removes the shapes named, and nothing else", () => {
    store.setCanvasState("room1", [shape("a"), shape("b"), shape("c")]);

    store.updateCanvasState("room1", null, ["b"], false);

    expect(store.getCanvasState("room1").map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("matches ids as strings here too", () => {
    store.setCanvasState("room1", [shape(1), shape("2")]);

    store.updateCanvasState("room1", null, ["1"], false);

    expect(store.getCanvasState("room1").map((s) => String(s.id))).toEqual([
      "2",
    ]);
  });

  it("applies after the merge when one payload carries both", () => {
    // A client that draws and erases in the same frame sends one update. Were
    // the order reversed, the deletion would miss a shape that arrived with it
    // and the erased shape would come back.
    store.setCanvasState("room1", [shape("a")]);

    store.updateCanvasState("room1", [shape("b"), shape("c")], ["b"], false);

    expect(store.getCanvasState("room1").map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("is a no-op for a room with no scene", () => {
    store.updateCanvasState("room1", null, ["a"], false);

    expect(store.hasCanvasState("room1")).toBe(false);
  });

  it("can empty a scene without dropping it", () => {
    // The room is still occupied; an empty scene is a legitimate state, and the
    // difference between "empty" and "absent" is what a joining peer is told.
    store.setCanvasState("room1", [shape("a")]);

    store.updateCanvasState("room1", null, ["a"], false);

    expect(store.hasCanvasState("room1")).toBe(true);
    expect(store.getCanvasState("room1")).toEqual([]);
  });
});

describe("stats", () => {
  it("counts rooms, heads and whether a scene is cached", () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket1");
    store.addUserToRoom("room1", "user2", "Grace", "socket2");
    store.addUserToRoom("room2", "user3", "Alan", "socket3");
    store.setCanvasState("room1", [shape("a")]);

    expect(store.getStats()).toEqual({
      activeRooms: 2,
      rooms: [
        { roomId: "room1", userCount: 2, hasCanvasState: true },
        { roomId: "room2", userCount: 1, hasCanvasState: false },
      ],
    });
  });

  it("says nothing is happening when nothing is", () => {
    expect(store.getStats()).toEqual({ activeRooms: 0, rooms: [] });
  });
});
