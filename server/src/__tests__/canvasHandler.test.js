/**
 * The canvas handlers: the two events that carry drawings between clients.
 *
 * Both are relays, and a relay's failure modes are quiet — a dropped update is
 * somebody's shape that never appeared on the other screen, and an unchecked one
 * is a client editing a room it never joined. The membership check in front of
 * each is the load-bearing part, so it is asserted from the outside here rather
 * than read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import validation from "../validation.js";
import { createHarness } from "./helpers/handlerHarness.js";

const { MAX_SHAPES_PER_UPDATE } = validation;

const shape = (id, extra = {}) => ({ id, tool: "Square", x: 0, y: 0, ...extra });

/** In the room, as far as the store is concerned. */
const join = (h, roomId = "room1", userId = "user1") => {
  h.store.addUserToRoom(roomId, userId, "Ada", h.socket.id);
};

let h;

beforeEach(() => {
  h = createHarness({ handler: "canvas" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  h.cleanup();
  vi.restoreAllMocks();
});

describe("what it listens for", () => {
  it("registers both canvas events", () => {
    expect(h.events().sort()).toEqual(["canvas-state-response", "canvas-update"]);
  });
});

describe("canvas-update", () => {
  it("stores, relays, and schedules a durable write", () => {
    join(h);

    h.fire("canvas-update", { roomId: "room1", shapes: [shape("a")] });

    expect(h.store.getCanvasState("room1").map((s) => s.id)).toEqual(["a"]);
    expect(h.roomState.scheduleFlush).toHaveBeenCalledWith("room1", [
      shape("a"),
    ]);
    expect(h.sent("canvas-update")).toEqual([
      {
        to: "room:room1",
        event: "canvas-update",
        payload: {
          roomId: "room1",
          shapes: [shape("a")],
          deletedShapeIds: null,
          fullUpdate: false,
        },
      },
    ]);
  });

  it("relays to the room but not back to the sender", () => {
    // `socket.to(room)` excludes this socket; `io.to(room)` would not, and the
    // sender receiving its own update is how a client ends up fighting itself.
    join(h);

    h.fire("canvas-update", { roomId: "room1", shapes: [shape("a")] });

    expect(h.sent("canvas-update")[0].to).toBe("room:room1");
    expect(h.emitted.some((e) => e.to === "self")).toBe(false);
  });

  it("ignores an update for a room this socket has not joined", () => {
    // Without this, any connected client could rewrite any room's canvas by
    // naming it — the room id is in the payload, and room ids are shareable.
    join(h, "room1");

    h.fire("canvas-update", { roomId: "room2", shapes: [shape("a")] });

    expect(h.store.hasCanvasState("room2")).toBe(false);
    expect(h.emitted).toEqual([]);
    expect(h.roomState.scheduleFlush).not.toHaveBeenCalled();
  });

  it("ignores an update from a socket in no room at all", () => {
    h.fire("canvas-update", { roomId: "room1", shapes: [shape("a")] });

    expect(h.store.hasCanvasState("room1")).toBe(false);
    expect(h.emitted).toEqual([]);
  });

  it("ignores a malformed or missing room id", () => {
    join(h);

    h.fire("canvas-update", { shapes: [shape("a")] });
    h.fire("canvas-update", { roomId: "", shapes: [shape("a")] });
    h.fire("canvas-update", { roomId: 42, shapes: [shape("a")] });
    h.fire("canvas-update", undefined);

    expect(h.emitted).toEqual([]);
  });

  it("says nothing when neither the shapes nor the deletions survive", () => {
    // A payload of junk is not an empty update: relaying it would tell every
    // peer to redraw nothing, and scheduling a flush would write that.
    join(h);

    h.fire("canvas-update", { roomId: "room1", shapes: ["nope"], deletedShapeIds: [7] });

    expect(h.emitted).toEqual([]);
    expect(h.roomState.scheduleFlush).not.toHaveBeenCalled();
  });

  it("passes deletions through on their own", () => {
    join(h);
    h.store.setCanvasState("room1", [shape("a"), shape("b")]);

    h.fire("canvas-update", { roomId: "room1", deletedShapeIds: ["a"] });

    expect(h.store.getCanvasState("room1").map((s) => s.id)).toEqual(["b"]);
    expect(h.sent("canvas-update")[0].payload).toEqual({
      roomId: "room1",
      shapes: null,
      deletedShapeIds: ["a"],
      fullUpdate: false,
    });
  });

  it("flushes an empty scene for a room that has nothing to delete from", () => {
    // The `|| []` behind the flush. A deletions-only update for a room with no
    // cached scene leaves the store with no entry at all, and `flushRoom` returns
    // early on `undefined` while it happily writes an empty array. Reachable only
    // on a board nothing was ever saved for — `join-room` hydrates the cache
    // before any update can get past the membership check — so the write this
    // schedules cannot blank a stored scene.
    join(h);

    h.fire("canvas-update", { roomId: "room1", deletedShapeIds: ["a"] });

    expect(h.store.getCanvasState("room1")).toBeUndefined();
    expect(h.roomState.scheduleFlush).toHaveBeenCalledWith("room1", []);
  });

  it("flushes the whole scene, not just the update that arrived", () => {
    // What gets written is the room's state of the world; an incremental update
    // on its own would overwrite the board with one shape.
    join(h);
    h.store.setCanvasState("room1", [shape("a")]);

    h.fire("canvas-update", { roomId: "room1", shapes: [shape("b")] });

    const [, flushed] = h.roomState.scheduleFlush.mock.calls[0];
    expect(flushed.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("takes fullUpdate as a fact about the payload, whatever its type", () => {
    join(h);
    h.store.setCanvasState("room1", [shape("a")]);

    h.fire("canvas-update", { roomId: "room1", shapes: [shape("b")], fullUpdate: 1 });

    expect(h.store.getCanvasState("room1").map((s) => s.id)).toEqual(["b"]);
    expect(h.sent("canvas-update")[0].payload.fullUpdate).toBe(true);
  });

  it("forwards only the fields it understands", () => {
    // The payload is attacker-controlled; anything copied through reaches every
    // other client in the room.
    join(h);

    h.fire("canvas-update", {
      roomId: "room1",
      shapes: [shape("a")],
      userId: "someone-else",
      script: "<img onerror=alert(1)>",
    });

    expect(Object.keys(h.sent("canvas-update")[0].payload).sort()).toEqual([
      "deletedShapeIds",
      "fullUpdate",
      "roomId",
      "shapes",
    ]);
  });

  it("drops shapes without a usable id before storing or relaying", () => {
    join(h);

    h.fire("canvas-update", {
      roomId: "room1",
      shapes: [shape("a"), shape(7), shape("b"), { tool: "Square" }],
    });

    expect(h.sent("canvas-update")[0].payload.shapes.map((s) => s.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("canvas-state-response", () => {
  /** The peer that asked for the scene, waiting on `canvas-state-sync`. */
  const asker = (h) => {
    h.store.addUserToRoom("room1", "user2", "Grace", "socket-2");
  };

  it("hands the scene to the peer that asked, and caches it for the next one", () => {
    join(h);
    asker(h);

    h.fire("canvas-state-response", {
      roomId: "room1",
      targetUserId: "user2",
      userId: "user1",
      shapes: [shape("a")],
    });

    expect(h.store.getCanvasState("room1").map((s) => s.id)).toEqual(["a"]);
    expect(h.roomState.scheduleFlush).toHaveBeenCalledWith("room1", [shape("a")]);
    expect(h.sent("canvas-state-sync")).toEqual([
      {
        to: "socket-2",
        event: "canvas-state-sync",
        payload: { roomId: "room1", userId: "user1", shapes: [shape("a")] },
      },
    ]);
  });

  it("answers that one socket, not the whole room", () => {
    // Everyone else already has the scene; a room-wide reply would make every
    // join redraw every client's canvas.
    join(h);
    asker(h);

    h.fire("canvas-state-response", {
      roomId: "room1",
      targetUserId: "user2",
      shapes: [shape("a")],
    });

    expect(h.emitted.every((e) => !e.to.startsWith("room:"))).toBe(true);
  });
  it("will not take a scene from a socket outside the room", () => {
    // This is the one event where a client hands the server a whole canvas. A
    // stranger who could send it would decide what every later joiner sees.
    join(h, "room1");
    h.store.addUserToRoom("room2", "user2", "Grace", "socket-2");

    h.fire("canvas-state-response", {
      roomId: "room2",
      targetUserId: "user2",
      shapes: [shape("a")],
    });

    expect(h.store.hasCanvasState("room2")).toBe(false);
    expect(h.emitted).toEqual([]);
    expect(h.roomState.scheduleFlush).not.toHaveBeenCalled();
  });

  it("ignores a malformed or missing room id", () => {
    join(h);
    asker(h);

    h.fire("canvas-state-response", { targetUserId: "user2", shapes: [shape("a")] });
    h.fire("canvas-state-response", { roomId: "", targetUserId: "user2" });
    h.fire("canvas-state-response", undefined);

    expect(h.emitted).toEqual([]);
    expect(h.store.hasCanvasState("room1")).toBe(false);
  });

  it("still caches the scene when the peer that asked has already left", () => {
    // The answer is late, but the scene in it is not: caching it is what saves
    // the next joiner from asking again.
    join(h);

    h.fire("canvas-state-response", {
      roomId: "room1",
      targetUserId: "user-who-left",
      shapes: [shape("a")],
    });

    expect(h.store.getCanvasState("room1").map((s) => s.id)).toEqual(["a"]);
    expect(h.roomState.scheduleFlush).toHaveBeenCalledTimes(1);
    expect(h.sent("canvas-state-sync")).toEqual([]);
  });
  it("tells the asker there is nothing, rather than leaving them waiting", () => {
    // Nothing in the payload survived, so there is no scene to cache — but the
    // asker is blocked on an answer, and `shapes: null` is one.
    join(h);
    asker(h);

    h.fire("canvas-state-response", {
      roomId: "room1",
      targetUserId: "user2",
      shapes: "not an array",
    });

    expect(h.store.hasCanvasState("room1")).toBe(false);
    expect(h.roomState.scheduleFlush).not.toHaveBeenCalled();
    expect(h.sent("canvas-state-sync")[0].payload.shapes).toBeNull();
  });

  it("caps how much one response can carry", () => {
    // `sanitizeShapes` stops at 500 per payload, below the 2000 a room may hold,
    // so that is the cap that actually bites here.
    join(h);
    asker(h);

    h.fire("canvas-state-response", {
      roomId: "room1",
      targetUserId: "user2",
      shapes: Array.from({ length: MAX_SHAPES_PER_UPDATE + 100 }, (_, i) =>
        shape(`s${i}`),
      ),
    });

    expect(h.store.getCanvasState("room1")).toHaveLength(MAX_SHAPES_PER_UPDATE);
  });

  it("forwards only the fields it understands", () => {
    join(h);
    asker(h);

    h.fire("canvas-state-response", {
      roomId: "room1",
      targetUserId: "user2",
      shapes: [shape("a")],
      socketId: "socket-1",
      script: "<img onerror=alert(1)>",
    });

    expect(Object.keys(h.sent("canvas-state-sync")[0].payload).sort()).toEqual([
      "roomId",
      "shapes",
      "userId",
    ]);
  });
});
