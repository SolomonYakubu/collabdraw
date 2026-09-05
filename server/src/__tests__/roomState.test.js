/**
 * The flush pipeline: coalescing edits into one write, and — the reason this
 * file exists — whether a flush that nobody is holding can be waited for.
 * `state.js` starts one with `void` when the last user leaves a room, and
 * `io.close()` disconnects everybody at once, so on shutdown the writes that
 * matter most are exactly the unheld ones.
 *
 * Redis and Postgres are stubbed by replacing the exports of `./redis` and
 * `./db` before `roomState` is loaded, because it destructures them at load
 * time. Note `vi.mock` is *not* what does this: `server/` is CommonJS, and
 * Vitest's mocker rewrites `import` statements — a `require` inside a CJS module
 * reaches the real thing, silently, so a mocked test would have passed against
 * an unconfigured (no-op) database and asserted nothing.
 */
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodeRequire = createRequire(import.meta.url);

/** The real vocabulary, so the stub answers what the module under test will see. */
const { SCENE_WRITE } = nodeRequire("../db.js");

const saveBoardScene = vi.fn(async () => SCENE_WRITE.SAVED);
const redisSet = vi.fn(async () => {});

const shape = (id) => ({ id, tool: "Square", x: 0, y: 0 });

/**
 * A fresh module instance, so one test's pending flushes are not another's.
 *
 * The state client is the seam for the snapshot cache below: `null` is a
 * deployment with no Redis, and a fake with `get`/`del` lets the read and delete
 * paths be driven as well as the write.
 */
const load = (stateClient = { set: redisSet }) => {
  nodeRequire("../db.js").saveBoardScene = saveBoardScene;
  nodeRequire("../redis.js").getStateClient = () => stateClient;
  delete nodeRequire.cache[nodeRequire.resolve("../roomState.js")];
  return nodeRequire("../roomState.js");
};

/** A write held open until it is let go, for asserting what waits on it. */
const gate = () => {
  let open;
  const held = new Promise((resolve) => {
    open = resolve;
  });
  return { held, open: () => open() };
};

/**
 * Let every queued promise continuation run. Enough turns that a chain which is
 * *going* to settle has, so "still pending" means pending on the gate and not on
 * a microtask — and unlike a timer, it reads the same under fake ones.
 */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  saveBoardScene.mockReset();
  saveBoardScene.mockImplementation(async () => SCENE_WRITE.SAVED);
  redisSet.mockReset();
  redisSet.mockImplementation(async () => {});
  // Both stores log their own failures, and several tests below arrange one.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * The 24-hour Redis copy: a room's hot cache, and on a deployment with no
 * Postgres the only place its scene survives a page reload. Every failure here
 * is deliberately swallowed — losing a cache write costs nothing durable, and
 * the caller is usually a flush nobody is holding — which is the reason each of
 * those paths needs a test saying so out loud.
 */
describe("the Redis snapshot", () => {
  const client = () => ({
    set: vi.fn(async () => "OK"),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
  });

  const KEY = "collabdraw:room:room1:canvas";

  it("is not written, read or deleted when there is no Redis", async () => {
    const { saveCanvasState, loadCanvasState, deleteCanvasState } = load(null);

    await expect(saveCanvasState("room1", [shape("a")])).resolves.toBeUndefined();
    await expect(loadCanvasState("room1")).resolves.toBeNull();
    await expect(deleteCanvasState("room1")).resolves.toBeUndefined();
  });

  it("is stored under the room's key, to expire in a day", async () => {
    const redis = client();
    const { saveCanvasState } = load(redis);

    await saveCanvasState("room1", [shape("a")]);

    expect(redis.set).toHaveBeenCalledWith(
      KEY,
      JSON.stringify([shape("a")]),
      "EX",
      86_400,
    );
  });

  it("logs a write Redis refused, and lets the durable one go ahead", async () => {
    // A rejection here would be an unhandled one — `flushRoom`'s caller holds
    // nothing — and would abandon the Postgres write queued behind it.
    const redis = client();
    redis.set.mockRejectedValue(new Error("READONLY"));
    const { saveCanvasState } = load(redis);

    await expect(saveCanvasState("room1", [shape("a")])).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "Redis canvas snapshot write failed:",
      "READONLY",
    );
  });
});
describe("reading the snapshot back, which is what a joiner is shown", () => {
  const client = (get) => ({ set: vi.fn(async () => "OK"), get, del: vi.fn() });

  const reading = (value) =>
    load(client(vi.fn(async () => value))).loadCanvasState("room1");

  it("hands back the scene it stored", async () => {
    const redis = client(vi.fn(async () => JSON.stringify([shape("a")])));
    const { loadCanvasState } = load(redis);

    await expect(loadCanvasState("room1")).resolves.toEqual([shape("a")]);
    expect(redis.get).toHaveBeenCalledWith("collabdraw:room:room1:canvas");
  });

  it("says nothing for a room that has expired out of the cache", async () => {
    await expect(reading(null)).resolves.toBeNull();
  });

  it("refuses a value that is not a scene", async () => {
    // `join-room` hydrates from this and sends what it gets to the client as its
    // whole canvas, so a stored object or number has to read as no snapshot.
    for (const value of ['{"shapes":[]}', '"a string"', "42", "null"]) {
      await expect(reading(value)).resolves.toBeNull();
    }
  });

  it("logs unreadable JSON rather than throwing at the joining client", async () => {
    // A truncated value is a real Redis outcome. The throw would land in
    // `join-room`, and the joiner would get no canvas and no error either.
    await expect(reading("[{not json")).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "Redis canvas snapshot read failed:",
      expect.any(String),
    );
  });

  it("falls back to no snapshot when Redis will not answer", async () => {
    const redis = client(vi.fn(async () => Promise.reject(new Error("ETIMEDOUT"))));
    const { loadCanvasState } = load(redis);

    await expect(loadCanvasState("room1")).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "Redis canvas snapshot read failed:",
      "ETIMEDOUT",
    );
  });

  it("can be dropped by key, though nothing calls that yet", async () => {
    // Exported for a board that is cleared or deleted while a room is open; the
    // room-empty path lets the key expire on its own instead.
    const redis = client(vi.fn());
    const { deleteCanvasState } = load(redis);

    await deleteCanvasState("room1");

    expect(redis.del).toHaveBeenCalledWith("collabdraw:room:room1:canvas");
  });
});

describe("scheduleFlush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("writes once, with the last scene, after the edits settle", async () => {
    const { scheduleFlush } = load();

    scheduleFlush("room1", [shape("a")]);
    scheduleFlush("room1", [shape("a"), shape("b")]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(saveBoardScene).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(saveBoardScene).toHaveBeenCalledTimes(1);
    expect(saveBoardScene.mock.calls[0][1]).toHaveLength(2);
  });

  it("writes the scene to both stores", async () => {
    const { scheduleFlush } = load();

    scheduleFlush("room1", [shape("a")]);
    await vi.advanceTimersByTimeAsync(3000);

    expect(redisSet).toHaveBeenCalledTimes(1);
    expect(saveBoardScene).toHaveBeenCalledWith("room1", [shape("a")]);
  });

  it("keeps one room's debounce separate from another's", async () => {
    const { scheduleFlush } = load();

    scheduleFlush("room1", [shape("a")]);
    await vi.advanceTimersByTimeAsync(1500);
    scheduleFlush("room2", [shape("b")]);
    await vi.advanceTimersByTimeAsync(1500);

    expect(saveBoardScene).toHaveBeenCalledTimes(1);
    expect(saveBoardScene.mock.calls[0][0]).toBe("room1");
  });
});

describe("flushRoomNow", () => {
  it("writes immediately and cancels the pending debounce", async () => {
    vi.useFakeTimers();
    const { scheduleFlush, flushRoomNow } = load();

    scheduleFlush("room1", [shape("a")]);
    await flushRoomNow("room1", [shape("a"), shape("b")]);
    expect(saveBoardScene).toHaveBeenCalledTimes(1);
    expect(saveBoardScene.mock.calls[0][1]).toHaveLength(2);

    // The debounce timer must not land a second, staler write.
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveBoardScene).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a room with no remembered scene", async () => {
    const { flushRoomNow } = load();

    await flushRoomNow("room1");

    expect(saveBoardScene).not.toHaveBeenCalled();
  });

  it("does not reject when a store fails, because callers do not hold it", async () => {
    // `state.js` calls this with `void`; a rejection here would be an unhandled
    // one, which for a server means a crash rather than a logged line.
    saveBoardScene.mockRejectedValue(new Error("connection terminated"));
    const { flushRoomNow } = load();

    await expect(flushRoomNow("room1", [shape("a")])).resolves.toBeUndefined();
  });
});

describe("flushAllRooms", () => {
  it("writes every dirty room", async () => {
    const { scheduleFlush, flushAllRooms } = load();

    scheduleFlush("room1", [shape("a")]);
    scheduleFlush("room2", [shape("b")]);
    await flushAllRooms();

    expect(saveBoardScene.mock.calls.map(([id]) => id).sort()).toEqual([
      "room1",
      "room2",
    ]);
  });

  it("waits for a flush that nobody is holding", async () => {
    // The shutdown race: `flushRoom` forgets the scene *synchronously* and only
    // then awaits the write, so by the time this runs there is no dirty room
    // left to find — and the process used to exit, or close the pool, with the
    // write still in flight.
    const order = [];
    const held = gate();
    saveBoardScene.mockImplementation(async () => {
      order.push("write:start");
      await held.held;
      order.push("write:end");
    });

    const { flushRoomNow, flushAllRooms } = load();

    void flushRoomNow("room1", [shape("a")]); // exactly what a disconnect does
    let finished = false;
    const done = flushAllRooms().then(() => {
      finished = true;
    });

    await settle();
    expect(finished).toBe(false);

    held.open();
    await done;
    expect(order).toEqual(["write:start", "write:end"]);
  });

  it("waits for a debounced flush that has already started", async () => {
    vi.useFakeTimers();
    const order = [];
    const held = gate();
    saveBoardScene.mockImplementation(async () => {
      order.push("write:start");
      await held.held;
      order.push("write:end");
    });

    const { scheduleFlush, flushAllRooms } = load();

    scheduleFlush("room1", [shape("a")]);
    await vi.advanceTimersByTimeAsync(3000); // the timer fires; the write begins
    expect(order).toEqual(["write:start"]);

    let finished = false;
    const done = flushAllRooms().then(() => {
      finished = true;
    });

    await settle();
    expect(finished).toBe(false);

    held.open();
    await done;
    expect(order).toEqual(["write:start", "write:end"]);
  });

  it("finishes the other rooms when one store fails", async () => {
    saveBoardScene.mockImplementation(async (roomId) => {
      if (roomId === "room1") throw new Error("connection terminated");
    });
    const { scheduleFlush, flushAllRooms } = load();

    scheduleFlush("room1", [shape("a")]);
    scheduleFlush("room2", [shape("b")]);

    await expect(flushAllRooms()).resolves.toBeUndefined();
    expect(saveBoardScene).toHaveBeenCalledTimes(2);
  });

  it("is quiet when there is nothing to write", async () => {
    const { flushAllRooms } = load();

    await flushAllRooms();

    expect(saveBoardScene).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });
});

/**
 * The other half of a durable write: telling the room what happened to it. Every
 * outcome below used to be a line in the server log while the room drew on into a
 * 24-hour cache.
 */
describe("the persistence report", () => {
  it("reports the write outcome for the room that was written", async () => {
    const reporter = vi.fn();
    const { scheduleFlush, setPersistenceReporter } = load();
    setPersistenceReporter(reporter);

    vi.useFakeTimers();
    scheduleFlush("room1", [shape("a")]);
    await vi.advanceTimersByTimeAsync(3000);

    expect(reporter).toHaveBeenCalledWith("room1", SCENE_WRITE.SAVED);
  });

  it("passes on a failure, rather than only the successes", async () => {
    // `deleted` is the one the room most needs: the board was removed from the
    // gallery in another tab, so nothing it draws from here on is being kept.
    saveBoardScene.mockResolvedValue(SCENE_WRITE.DELETED);
    const reporter = vi.fn();
    const { flushRoomNow, setPersistenceReporter } = load();
    setPersistenceReporter(reporter);

    await flushRoomNow("room1", [shape("a")]);

    expect(reporter).toHaveBeenCalledWith("room1", SCENE_WRITE.DELETED);
  });

  it("reports the flush that nobody is holding", async () => {
    // The room-empty flush `state.js` fires with `void`. The last user is gone,
    // but others may still be in the room.
    const reporter = vi.fn();
    const { flushRoomNow, flushAllRooms, setPersistenceReporter } = load();
    setPersistenceReporter(reporter);

    void flushRoomNow("room1", [shape("a")]);
    await flushAllRooms();

    expect(reporter).toHaveBeenCalledWith("room1", SCENE_WRITE.SAVED);
  });

  it("says nothing when the write threw instead of answering", async () => {
    // The real `saveBoardScene` returns `unreachable` rather than throwing, so
    // there is no outcome here to report — and inventing one would tell a room its
    // work is lost on the strength of a bug in this process.
    saveBoardScene.mockRejectedValue(new Error("connection terminated"));
    const reporter = vi.fn();
    const { flushRoomNow, setPersistenceReporter } = load();
    setPersistenceReporter(reporter);

    await flushRoomNow("room1", [shape("a")]);

    expect(reporter).not.toHaveBeenCalled();
  });

  it("writes normally when nothing is listening", async () => {
    // Which is every test of the flush pipeline above, and any use of this module
    // without a socket server — `index.js` is what wires the emit in.
    const { flushRoomNow, setPersistenceReporter } = load();
    setPersistenceReporter(undefined);

    await expect(flushRoomNow("room1", [shape("a")])).resolves.toBeUndefined();
    expect(saveBoardScene).toHaveBeenCalledTimes(1);
  });
});
