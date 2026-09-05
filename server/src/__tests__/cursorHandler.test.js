/**
 * The transient events: cursors, live preview strokes, and "I stopped drawing".
 *
 * These are the high-frequency ones — a cursor moves 20-60 times a second per
 * peer — and none of them is stored. That makes clamping the whole job: an
 * unclamped coordinate is a shape at 1e308 that pushes everyone's viewport into
 * infinity, and an oversized preview payload is that cost paid every frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHarness } from "./helpers/handlerHarness.js";

const shape = (id, extra = {}) => ({ id, tool: "Square", x: 0, y: 0, ...extra });

const join = (h, roomId = "room1", userId = "user1") => {
  h.store.addUserToRoom(roomId, userId, "Ada", h.socket.id);
};

let h;

beforeEach(() => {
  h = createHarness({ handler: "cursor" });
});

afterEach(() => {
  h.cleanup();
  vi.restoreAllMocks();
});

describe("what it listens for", () => {
  it("registers all three transient events", () => {
    expect(h.events().sort()).toEqual([
      "cursor-position",
      "drawing-state",
      "shape-in-progress",
    ]);
  });
});

describe("cursor-position", () => {
  it("relays the cursor to the rest of the room", () => {
    join(h);

    h.fire("cursor-position", {
      roomId: "room1",
      userId: "user1",
      x: 10,
      y: 20,
      tag: "Ada",
    });

    expect(h.sent("cursor-position")).toEqual([
      {
        to: "room:room1",
        event: "cursor-position",
        payload: { userId: "user1", x: 10, y: 20, tag: "Ada" },
      },
    ]);
  });

  it("does not send a peer their own cursor back", () => {
    join(h);

    h.fire("cursor-position", { roomId: "room1", userId: "user1", x: 1, y: 2 });

    expect(h.emitted.every((e) => e.to === "room:room1")).toBe(true);
  });

  it("ignores a cursor for a room this socket has not joined", () => {
    join(h, "room1");

    h.fire("cursor-position", { roomId: "room2", userId: "user1", x: 1, y: 2 });

    expect(h.emitted).toEqual([]);
  });

  it("ignores a malformed room id, or none", () => {
    join(h);

    h.fire("cursor-position", { userId: "user1", x: 1, y: 2 });
    h.fire("cursor-position", { roomId: "", userId: "user1", x: 1, y: 2 });
    h.fire("cursor-position", undefined);

    expect(h.emitted).toEqual([]);
  });

  it("says nothing without a user to attribute the cursor to", () => {
    join(h);

    h.fire("cursor-position", { roomId: "room1", x: 1, y: 2 });

    expect(h.emitted).toEqual([]);
  });

  it("drops a cursor whose coordinates are not numbers", () => {
    // A relayed NaN is a cursor that renders nowhere and can poison arithmetic
    // downstream; there is nothing to salvage from it.
    join(h);

    h.fire("cursor-position", { roomId: "room1", userId: "user1", x: "10", y: 20 });
    h.fire("cursor-position", { roomId: "room1", userId: "user1", x: 10, y: NaN });
    h.fire("cursor-position", { roomId: "room1", userId: "user1", x: Infinity, y: 0 });
    h.fire("cursor-position", { roomId: "room1", userId: "user1", y: 0 });

    expect(h.emitted).toEqual([]);
  });

  it("clamps a cursor to the reachable canvas instead of dropping it", () => {
    // Unlike a NaN, a far-away number is a real position — just further out than
    // anyone can draw. Clamping keeps the peer visible at the edge.
    join(h);

    h.fire("cursor-position", {
      roomId: "room1",
      userId: "user1",
      x: 1e9,
      y: -1e9,
    });

    expect(h.sent("cursor-position")[0].payload).toMatchObject({
      x: 1e6,
      y: -1e6,
    });
  });

  it("truncates a long tag rather than refusing the cursor", () => {
    join(h);

    h.fire("cursor-position", {
      roomId: "room1",
      userId: "user1",
      x: 0,
      y: 0,
      tag: "A".repeat(500),
    });

    expect(h.sent("cursor-position")[0].payload.tag).toHaveLength(64);
  });

  it("relays a cursor with no tag at all", () => {
    // The receiving client falls back to "User"; a missing tag must not cost the
    // peer their cursor.
    join(h);

    h.fire("cursor-position", { roomId: "room1", userId: "user1", x: 0, y: 0 });

    expect(h.sent("cursor-position")[0].payload.tag).toBeUndefined();
  });

  it("forwards only the fields it understands", () => {
    join(h);

    h.fire("cursor-position", {
      roomId: "room1",
      userId: "user1",
      x: 0,
      y: 0,
      socketId: "socket-1",
      script: "<img onerror=alert(1)>",
    });

    expect(Object.keys(h.sent("cursor-position")[0].payload).sort()).toEqual([
      "tag",
      "userId",
      "x",
      "y",
    ]);
  });
});

describe("shape-in-progress", () => {
  it("relays the preview stroke to the rest of the room", () => {
    join(h);

    h.fire("shape-in-progress", {
      roomId: "room1",
      userId: "user1",
      shape: shape("a", { isInProgress: true }),
    });

    expect(h.sent("shape-in-progress")).toEqual([
      {
        to: "room:room1",
        event: "shape-in-progress",
        payload: { userId: "user1", shape: shape("a", { isInProgress: true }) },
      },
    ]);
  });

  it("ignores a preview for a room this socket has not joined", () => {
    join(h, "room1");

    h.fire("shape-in-progress", {
      roomId: "room2",
      userId: "user1",
      shape: shape("a"),
    });

    expect(h.emitted).toEqual([]);
  });

  it("ignores a malformed room id, or none", () => {
    join(h);

    h.fire("shape-in-progress", { userId: "user1", shape: shape("a") });
    h.fire("shape-in-progress", { roomId: 7, userId: "user1", shape: shape("a") });
    h.fire("shape-in-progress", undefined);

    expect(h.emitted).toEqual([]);
  });

  it("says nothing without a user to attribute the stroke to", () => {
    // The receiver files previews per peer; an unattributed one has nowhere to go.
    join(h);

    h.fire("shape-in-progress", { roomId: "room1", shape: shape("a") });

    expect(h.emitted).toEqual([]);
  });

  it("drops a preview that is not a usable shape", () => {
    join(h);

    h.fire("shape-in-progress", { roomId: "room1", userId: "user1", shape: null });
    h.fire("shape-in-progress", { roomId: "room1", userId: "user1", shape: "square" });
    h.fire("shape-in-progress", { roomId: "room1", userId: "user1", shape: { x: 0 } });
    h.fire("shape-in-progress", { roomId: "room1", userId: "user1", shape: shape(7) });

    expect(h.emitted).toEqual([]);
  });

  it("drops a preview too large to be worth 60 of per second", () => {
    join(h);

    h.fire("shape-in-progress", {
      roomId: "room1",
      userId: "user1",
      shape: shape("a", { points: "x".repeat(33 * 1024) }),
    });

    expect(h.emitted).toEqual([]);
  });

  it("relays one shape, not an array of them", () => {
    // The payload field is singular, and the handler sanitizes `[shape]`; an
    // array arriving here must not become a batch nobody bounded.
    join(h);

    h.fire("shape-in-progress", {
      roomId: "room1",
      userId: "user1",
      shape: [shape("a"), shape("b")],
    });

    expect(h.emitted).toEqual([]);
  });
});

describe("drawing-state", () => {
  it("names the peer who stopped drawing", () => {
    // Without `userId` the receiver cannot tell whose preview to clear, so the
    // event is unattributable and the half-drawn shape stays on every canvas.
    join(h);

    h.fire("drawing-state", { roomId: "room1", userId: "user1", isDrawing: false });

    expect(h.sent("drawing-state")).toEqual([
      {
        to: "room:room1",
        event: "drawing-state",
        payload: { roomId: "room1", userId: "user1", isDrawing: false },
      },
    ]);
  });

  it("reduces the flag to a boolean", () => {
    join(h);

    h.fire("drawing-state", { roomId: "room1", userId: "user1", isDrawing: "yes" });
    h.fire("drawing-state", { roomId: "room1", userId: "user1" });

    expect(h.sent("drawing-state").map((e) => e.payload.isDrawing)).toEqual([
      true,
      false,
    ]);
  });

  it("ignores a state for a room this socket has not joined", () => {
    join(h, "room1");

    h.fire("drawing-state", { roomId: "room2", userId: "user1", isDrawing: false });

    expect(h.emitted).toEqual([]);
  });

  it("ignores a malformed room id, or none", () => {
    join(h);

    h.fire("drawing-state", { userId: "user1", isDrawing: false });
    h.fire("drawing-state", { roomId: "", userId: "user1" });
    h.fire("drawing-state", undefined);

    expect(h.emitted).toEqual([]);
  });

  it("says nothing without a user to attribute it to", () => {
    join(h);

    h.fire("drawing-state", { roomId: "room1", isDrawing: false });

    expect(h.emitted).toEqual([]);
  });

  it("forwards only the fields it understands", () => {
    join(h);

    h.fire("drawing-state", {
      roomId: "room1",
      userId: "user1",
      isDrawing: false,
      shapes: [shape("a")],
    });

    expect(Object.keys(h.sent("drawing-state")[0].payload).sort()).toEqual([
      "isDrawing",
      "roomId",
      "userId",
    ]);
  });
});
