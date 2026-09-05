/**
 * Room membership: joining, the roster everyone sees, renaming, and leaving.
 *
 * This is the handler with something to lose. A join has to answer the question
 * "what is already on this board?", and it has three places to look — the local
 * cache, the Redis hot copy, then Postgres — falling back to asking a peer only
 * when all three are empty. Get the order or an emptiness check wrong and a
 * joiner is shown a blank board that then overwrites the real one.
 *
 * The roster has a second seam: with a Redis adapter it is assembled from every
 * socket in the cluster, without one from this process's own store. The harness
 * makes the adapter throw by default, which is the single-instance deployment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHarness } from "./helpers/handlerHarness.js";

const shape = (id, extra = {}) => ({ id, tool: "Square", x: 0, y: 0, ...extra });

const join = (h, data) => h.fire("join-room", data);

/** A join with everything valid; individual tests override one field. */
const validJoin = { roomId: "room1", userId: "user1", userTag: "Ada" };

/** Someone already in the room, on their own socket. */
const peer = (h, { roomId = "room1", userId = "user2", socketId = "socket-2" } = {}) => {
  h.store.addUserToRoom(roomId, userId, "Grace", socketId);
  h.withRoomMembers(roomId, [socketId]);
};

let h;

beforeEach(() => {
  h = createHarness({ handler: "room" });
  // Every join logs; the assertions are on what was emitted, not printed.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  h.cleanup();
  vi.restoreAllMocks();
});

describe("what it listens for", () => {
  it("registers the membership events, disconnect included", () => {
    expect(h.events().sort()).toEqual([
      "disconnect",
      "get-active-users",
      "join-room",
      "update-user-name",
    ]);
  });
});
describe("join-room", () => {
  it("seats the user, joins the socket, and tells the room", async () => {
    await join(h, validJoin);

    expect(h.socket.join).toHaveBeenCalledWith("room1");
    expect(h.store.getRoomUsers("room1")).toEqual([{ id: "user1", tag: "Ada" }]);
    expect(h.sent("active-users")).toEqual([
      {
        to: "room1",
        event: "active-users",
        payload: { users: [{ id: "user1", tag: "Ada" }] },
      },
    ]);
  });

  it("stamps the socket, which is what a cluster-wide roster reads", async () => {
    // `fetchSockets()` returns sockets, not store rows; without this the roster
    // is empty on every instance but the one holding the store.
    await join(h, validJoin);

    expect(h.socket.data).toEqual({
      userId: "user1",
      userTag: "Ada",
      roomId: "room1",
    });
  });

  it("includes the joiner in the roster it broadcasts", async () => {
    // The broadcast goes to `io.to(room)`, which includes this socket — the
    // joiner learns who is here from the same message as everyone else.
    peer(h);

    await join(h, validJoin);

    expect(h.sent("active-users")[0].payload.users).toEqual([
      { id: "user2", tag: "Grace" },
      { id: "user1", tag: "Ada" },
    ]);
  });
});
describe("what a join refuses", () => {
  const refused = async (data) => {
    await join(h, data);
    expect(h.socket.join).not.toHaveBeenCalled();
    expect(h.emitted).toEqual([]);
    expect(h.store.getStats().activeRooms).toBe(0);
  };

  it("refuses a malformed or missing room id", async () => {
    await refused({ userId: "user1" });
    await refused({ roomId: "", userId: "user1" });
    await refused({ roomId: 42, userId: "user1" });
    await refused({ roomId: "r".repeat(129), userId: "user1" });
    await refused(undefined);
  });

  it("refuses a join with no usable user id", async () => {
    // The user id keys the roster and every later membership check; an anonymous
    // join would be a seat nobody could be removed from.
    await refused({ roomId: "room1" });
    await refused({ roomId: "room1", userId: "" });
    await refused({ roomId: "room1", userId: 7 });
    await refused({ roomId: "room1", userId: "u".repeat(129) });
  });

  it("takes a nameless join, under a name everyone can read", async () => {
    await join(h, { roomId: "room1", userId: "user1" });

    expect(h.store.getRoomUsers("room1")).toEqual([
      { id: "user1", tag: "Anonymous" },
    ]);
  });

  it("truncates a long tag rather than refusing the join", async () => {
    await join(h, { ...validJoin, userTag: "A".repeat(500) });

    expect(h.store.getRoomUsers("room1")[0].tag).toHaveLength(64);
  });
});
describe("one room at a time", () => {
  it("leaves the room it was in before joining another", async () => {
    // A socket in two rooms would receive both boards' updates and draw them on
    // top of each other.
    await join(h, validJoin);

    await join(h, { ...validJoin, roomId: "room2" });

    expect(h.socket.leave).toHaveBeenCalledWith("room1");
    expect(h.store.getRoomUsers("room1")).toEqual([]);
    expect(h.store.getRoomUsers("room2")).toEqual([{ id: "user1", tag: "Ada" }]);
  });

  it("tells the room it left who is still there", async () => {
    peer(h);
    await join(h, validJoin);

    await join(h, { ...validJoin, roomId: "room2" });

    const toOldRoom = h.sent("active-users").filter((e) => e.to === "room1");
    expect(toOldRoom.at(-1).payload.users).toEqual([
      { id: "user2", tag: "Grace" },
    ]);
  });

  it("says nothing to a room it emptied by leaving", async () => {
    await join(h, validJoin);

    await join(h, { ...validJoin, roomId: "room2" });

    // Only the original join's broadcast; nobody remains to hear a second.
    expect(h.sent("active-users").filter((e) => e.to === "room1")).toHaveLength(1);
  });

  it("does not leave the room it is re-joining", async () => {
    // A reconnect or a second join-room for the same room must not tear down the
    // membership it is renewing.
    await join(h, validJoin);

    await join(h, validJoin);

    expect(h.socket.leave).not.toHaveBeenCalled();
    expect(h.store.getRoomUsers("room1")).toEqual([{ id: "user1", tag: "Ada" }]);
  });
});
describe("what a joiner is shown", () => {
  /** Swap in a persistence layer that has something stored in it. */
  const rebuild = (roomState) => {
    h.cleanup();
    h = createHarness({ handler: "room", roomState });
    vi.spyOn(console, "log").mockImplementation(() => {});
  };

  it("serves the scene from memory, touching neither Redis nor Postgres", async () => {
    h.store.setCanvasState("room1", [shape("a")]);

    await join(h, validJoin);

    expect(h.sent("canvas-state-sync")).toEqual([
      {
        to: "self",
        event: "canvas-state-sync",
        payload: { roomId: "room1", userId: "server", shapes: [shape("a")] },
      },
    ]);
    expect(h.roomState.loadCanvasState).not.toHaveBeenCalled();
    expect(h.roomState.loadBoardScene).not.toHaveBeenCalled();
  });

  it("falls back to the Redis hot copy, and does not go on to Postgres", async () => {
    rebuild({ loadCanvasState: vi.fn(async () => [shape("a")]) });

    await join(h, validJoin);

    expect(h.sent("canvas-state-sync")[0].payload.shapes).toEqual([shape("a")]);
    expect(h.roomState.loadBoardScene).not.toHaveBeenCalled();
  });

  it("reads the board out of Postgres when neither cache has it", async () => {
    rebuild({ loadBoardScene: vi.fn(async () => [shape("a")]) });

    await join(h, validJoin);

    expect(h.sent("canvas-state-sync")[0].payload.shapes).toEqual([shape("a")]);
    // Seeded locally, so the next joiner is answered without a round trip.
    expect(h.store.getCanvasState("room1")).toEqual([shape("a")]);
  });

  it("treats an empty answer as no answer", async () => {
    // An empty array is what a room that was created and never drawn in returns;
    // stopping there would hide a board that Postgres does have.
    rebuild({
      loadCanvasState: vi.fn(async () => []),
      loadBoardScene: vi.fn(async () => [shape("a")]),
    });

    await join(h, validJoin);

    expect(h.roomState.loadBoardScene).toHaveBeenCalledWith("room1");
    expect(h.sent("canvas-state-sync")[0].payload.shapes).toEqual([shape("a")]);
  });
});
describe("asking a peer, when nothing is stored anywhere", () => {
  it("asks one of the sockets already in the room", async () => {
    peer(h);

    await join(h, validJoin);

    expect(h.sent("request-canvas-state")).toEqual([
      {
        to: "socket-2",
        event: "request-canvas-state",
        payload: { roomId: "room1", targetUserId: "user1" },
      },
    ]);
    expect(h.sent("canvas-state-sync")).toEqual([]);
  });

  it("asks exactly one of them, not the whole room", async () => {
    // Every peer answering would relay the entire scene once per peer, and each
    // answer overwrites the cached copy on arrival.
    peer(h);
    h.store.addUserToRoom("room1", "user3", "Alan", "socket-3");
    h.withRoomMembers("room1", ["socket-2", "socket-3"]);

    await join(h, validJoin);

    expect(h.sent("request-canvas-state")).toHaveLength(1);
  });

  it("never asks the joiner for the state it is joining to get", async () => {
    peer(h);

    await join(h, validJoin);

    expect(h.sent("request-canvas-state")[0].to).not.toBe(h.socket.id);
  });

  it("asks nobody when it is the first one in", async () => {
    // Alone in an empty room: there is no scene, and that is the answer.
    await join(h, validJoin);

    expect(h.emitted.map((e) => e.event)).toEqual(["active-users"]);
  });

  it("asks nobody when the roster has peers but the adapter has no sockets", async () => {
    // The store says someone is here, the adapter disagrees. Emitting to a socket
    // id nobody holds would strand the joiner waiting for an answer, so the join
    // ends quietly instead.
    h.store.addUserToRoom("room1", "user2", "Grace", "socket-2");

    await join(h, validJoin);

    expect(h.sent("request-canvas-state")).toEqual([]);
  });
});
describe("the roster, with a Redis adapter behind it", () => {
  it("assembles it from every socket in the cluster", async () => {
    // Grace is on another instance, so she is in no local store here. Without the
    // adapter path she would be invisible to this room's roster.
    h.withClusterSockets([
      { data: { userId: "user1", userTag: "Ada" } },
      { data: { userId: "user2", userTag: "Grace" } },
    ]);

    await join(h, validJoin);

    expect(h.sent("active-users")[0].payload.users).toEqual([
      { id: "user1", tag: "Ada" },
      { id: "user2", tag: "Grace" },
    ]);
  });

  it("names a socket that never sent one", async () => {
    h.withClusterSockets([{ data: { userId: "user2" } }]);

    await join(h, validJoin);

    expect(h.sent("active-users")[0].payload.users).toEqual([
      { id: "user2", tag: "Anonymous" },
    ]);
  });

  it("counts a user once, however many sockets they hold", async () => {
    // Two tabs is one person in the room; two rows would be two people leaving
    // when one tab closes.
    h.withClusterSockets([
      { data: { userId: "user1", userTag: "Ada" } },
      { data: { userId: "user1", userTag: "Ada" } },
    ]);

    await join(h, validJoin);

    expect(h.sent("active-users")[0].payload.users).toEqual([
      { id: "user1", tag: "Ada" },
    ]);
  });

  it("falls back to this process's store when the cluster answers with nobody", async () => {
    // Sockets exist but none has identified itself yet. An empty roster would
    // clear the people list for everyone in the room.
    h.withClusterSockets([{ data: {} }, {}]);

    await join(h, validJoin);

    expect(h.sent("active-users")[0].payload.users).toEqual([
      { id: "user1", tag: "Ada" },
    ]);
  });
});
describe("get-active-users", () => {
  it("answers a member with the room's roster", async () => {
    await join(h, validJoin);
    const callback = vi.fn();

    await h.fire("get-active-users", { roomId: "room1" }, callback);

    expect(callback).toHaveBeenCalledWith({
      users: [{ id: "user1", tag: "Ada" }],
    });
  });

  it("tells a stranger nothing about who is in the room", async () => {
    // Room ids travel in share links. Answering a non-member would turn any link
    // into a way to watch who is on the board without joining it.
    peer(h);

    const callback = vi.fn();
    await h.fire("get-active-users", { roomId: "room1" }, callback);

    expect(callback).toHaveBeenCalledWith({ users: [] });
  });

  it("answers a member asking about some other room with nothing", async () => {
    await join(h, validJoin);
    peer(h, { roomId: "room2", socketId: "socket-3" });

    const callback = vi.fn();
    await h.fire("get-active-users", { roomId: "room2" }, callback);

    expect(callback).toHaveBeenCalledWith({ users: [] });
  });

  it("does nothing when there is nothing to answer to", async () => {
    // Socket.IO acknowledgements are optional; a caller that sent none must not
    // take the connection down with a TypeError.
    await join(h, validJoin);

    await expect(h.fire("get-active-users", { roomId: "room1" })).resolves.toBeUndefined();
    await expect(h.fire("get-active-users", undefined)).resolves.toBeUndefined();
  });
});
describe("update-user-name", () => {
  const rosterAfterRename = () => h.sent("active-users").at(-1).payload.users;

  it("renames you and rebroadcasts the roster", async () => {
    await join(h, validJoin);

    await h.fire("update-user-name", { userTag: "Ada L." });

    expect(rosterAfterRename()).toEqual([{ id: "user1", tag: "Ada L." }]);
    expect(h.sent("active-users").at(-1).to).toBe("room1");
  });

  it("renames the caller, never whoever the payload names", async () => {
    // The one guard that matters here: identity comes from `socket.data`. Taking
    // it off the wire would let any client rename anybody else in the room.
    await join(h, validJoin);
    peer(h);

    await h.fire("update-user-name", { userId: "user2", userTag: "Renamed" });

    expect(h.store.getUserInRoom("room1", "user2").tag).toBe("Grace");
    expect(h.store.getUserInRoom("room1", "user1").tag).toBe("Renamed");
  });

  it("updates the socket too, which is what the cluster roster reads", async () => {
    // Two stores hold the tag. If only the local one were updated, the name would
    // revert the moment the roster came back from the adapter.
    h.withClusterSockets([h.socket]);
    await join(h, validJoin);

    await h.fire("update-user-name", { userTag: "Ada L." });

    expect(h.socket.data.userTag).toBe("Ada L.");
    expect(rosterAfterRename()).toEqual([{ id: "user1", tag: "Ada L." }]);
  });

  it("says nothing when the name has not changed", async () => {
    // The roster is rebroadcast to everyone; a no-op rename is a message every
    // client in the room parses for nothing.
    await join(h, validJoin);

    await h.fire("update-user-name", { userTag: "Ada" });

    expect(h.sent("active-users")).toHaveLength(1);
  });

  it("ignores a tag it cannot use", async () => {
    await join(h, validJoin);

    await h.fire("update-user-name", {});
    await h.fire("update-user-name", { userTag: "" });
    await h.fire("update-user-name", { userTag: 7 });
    await h.fire("update-user-name", undefined);

    expect(h.sent("active-users")).toHaveLength(1);
  });

  it("truncates a long tag rather than refusing the rename", async () => {
    await join(h, validJoin);

    await h.fire("update-user-name", { userTag: "A".repeat(500) });

    expect(rosterAfterRename()[0].tag).toHaveLength(64);
  });

  it("ignores a rename from a socket that never joined a room", async () => {
    await h.fire("update-user-name", { userTag: "Ada L." });

    expect(h.emitted).toEqual([]);
  });

  it("ignores a rename once the store no longer places the socket in the room", async () => {
    // `socket.data` still names a room the store has forgotten — a disconnect that
    // raced the message. Renaming would resurrect a seat nobody is in.
    await join(h, validJoin);
    h.store.removeUserBySocketId(h.socket.id);

    await h.fire("update-user-name", { userTag: "Ada L." });

    expect(h.sent("active-users")).toHaveLength(1);
  });
});
describe("disconnect", () => {
  it("removes the user and tells whoever is left", async () => {
    await join(h, validJoin);
    peer(h);

    await h.fire("disconnect");

    expect(h.store.getRoomUsers("room1")).toEqual([{ id: "user2", tag: "Grace" }]);
    expect(h.sent("active-users").at(-1)).toEqual({
      to: "room1",
      event: "active-users",
      payload: { users: [{ id: "user2", tag: "Grace" }] },
    });
  });

  it("says nothing to a room that just emptied", async () => {
    // There is nobody to hear it, and the room is gone from the store — the
    // roster would be assembled for an audience of none.
    await join(h, validJoin);

    await h.fire("disconnect");

    expect(h.sent("active-users")).toHaveLength(1);
    expect(h.store.getStats().activeRooms).toBe(0);
  });

  it("has nothing to do for a socket that was never in a room", async () => {
    await h.fire("disconnect");

    expect(h.emitted).toEqual([]);
  });
});
