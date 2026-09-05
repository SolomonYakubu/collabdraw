/**
 * The HTTP half of the server: the routes, the persistence broadcast, and the
 * shutdown wiring — all of which `server/src/index.js` does at require time.
 *
 * There is no setup function to call: requiring the module starts a listener and
 * installs signal handlers. So its collaborators are faked at the require cache
 * (Socket.IO, Redis, the job queue, `./shutdown`) while express, `./state` and
 * `./db`'s outcome vocabulary stay real, and every request below is a real one
 * over a real socket on an ephemeral port.
 */
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModuleCache } from "./helpers/moduleCache.js";

const cache = createModuleCache();

const { SCENE_WRITE } = cache.real("./db.js");
const SHUTDOWN = Symbol("shutdown");

/** Every `io.to(room).emit(event, payload)` the module made, in order. */
let emitted;
/** The reporter `./roomState` was handed. */
let reporter;
/** What `createShutdown` was called with, and what was installed for signals. */
let shutdownConfig;
let installed;
/** The queue functions the two `/jobs` routes call. */
let queue;
/** The room-state module, for the reporter it was handed and the flush. */
let roomState;
/** The real room store this boot is using. */
let store;
/** The http server `initSocket` was attached to. */
let attachedTo;

const load = ({ clientOrigin = "http://localhost:3000", isProduction = false } = {}) => {
  emitted = [];
  reporter = null;
  shutdownConfig = null;
  installed = [];

  cache.plant("./config.js", {
    port: 0,
    clientOrigin,
    isProduction,
    shutdownTimeoutMs: 10_000,
  });

  cache.plant("./socket.js", (httpServer) => {
    attachedTo = httpServer;
    return {
      to: (roomId) => ({
        emit: (event, payload) => emitted.push({ roomId, event, payload }),
      }),
    };
  });
  cache.plant("./redis.js", { closeRedis: vi.fn(async () => {}) });

  roomState = {
    flushAllRooms: vi.fn(async () => {}),
    setPersistenceReporter: vi.fn((fn) => {
      reporter = fn;
    }),
  };
  cache.plant("./roomState.js", roomState);

  queue = {
    closeGenerationQueue: vi.fn(async () => {}),
    enqueueGenerationJob: vi.fn(async () => ({ id: "job-1" })),
    getGenerationJob: vi.fn(async () => null),
  };
  cache.plant("./jobs/generationQueue.js", queue);

  // The real one installs SIGINT/SIGTERM/`uncaughtException` handlers on the
  // process this test shares with every other file, and calls `process.exit`.
  cache.plant("./shutdown.js", {
    createShutdown: vi.fn((options) => {
      shutdownConfig = options;
      return SHUTDOWN;
    }),
    installShutdownHandlers: vi.fn((shutdown) => installed.push(shutdown)),
  });

  store = cache.load("./state.js");
  return cache.load("./index.js");
};

/** The module under test, once it is listening, plus a base URL for it. */
let index;
let base;

const boot = async (options) => {
  index = load(options);
  // `listen()` binds synchronously — `address()` is already there — but emits
  // `listening`, and so runs the module's callback, on the next tick.
  await once(index.server, "listening");
  base = `http://127.0.0.1:${index.server.address().port}`;
  return index;
};

const get = (path, headers) => fetch(`${base}${path}`, { headers });

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (index?.server?.listening) {
    // `fetch` keeps its connection alive, and `close` waits for open sockets.
    index.server.closeAllConnections?.();
    await new Promise((resolve) => index.server.close(resolve));
  }
  index = null;
  cache.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the server it starts", () => {
  it("listens on the configured port and says which", async () => {
    await boot();

    expect(index.server.listening).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      "CollabDraw Socket.IO server running on port 0",
    );
  });

  it("answers a health check, which is what keeps the dyno alive", async () => {
    // Render and Railway poll this; a 404 here reads as an unhealthy instance and
    // gets the container replaced mid-session.
    await boot();

    const response = await get("/");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("CollabDraw Socket.IO server is running");
  });

  it("allows the configured origin to call it with credentials", async () => {
    await boot({ clientOrigin: "https://collabdraw.example" });

    const response = await get("/", { origin: "https://collabdraw.example" });

    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://collabdraw.example",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("attaches Socket.IO to the very server that is listening", async () => {
    // A separate http server would leave the websocket upgrade unanswered on the
    // port the client is actually dialling.
    await boot();

    expect(attachedTo).toBe(index.server);
    expect(typeof index.io.to).toBe("function");
  });
});
describe("/stats", () => {
  const seat = () => store.addUserToRoom("room1", "user1", "Ada", "socket-1");

  it("reports the open rooms and who is in them", async () => {
    await boot();
    seat();

    const response = await get("/stats");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      activeRooms: 1,
      rooms: [{ roomId: "room1", userCount: 1, hasCanvasState: false }],
    });
  });

  it("is open in development, token or no token", async () => {
    // The guard is production-only by design: local dev has nothing to set.
    vi.stubEnv("STATS_TOKEN", "s3cret");
    await boot({ isProduction: false });

    expect((await get("/stats")).status).toBe(200);
  });

  it("is open in production when no token is configured", async () => {
    // Worth stating rather than assuming: with STATS_TOKEN unset, a deployed
    // instance publishes its room ids and head counts to anyone who asks.
    vi.stubEnv("STATS_TOKEN", "");
    await boot({ isProduction: true });

    expect((await get("/stats")).status).toBe(200);
  });
});
describe("/stats in production, with a token set", () => {
  const unauthorized = { error: "Unauthorized access to server stats." };

  beforeEach(async () => {
    vi.stubEnv("STATS_TOKEN", "s3cret");
    await boot({ isProduction: true });
  });

  it("refuses a caller with no credential", async () => {
    const response = await get("/stats");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
  });

  it("refuses the wrong token", async () => {
    const response = await get("/stats", { authorization: "Bearer guessed" });

    expect(response.status).toBe(401);
  });

  it("takes the token as a bearer credential", async () => {
    const response = await get("/stats", { authorization: "Bearer s3cret" });

    expect(response.status).toBe(200);
  });

  it("takes it bare too, in either header", async () => {
    expect((await get("/stats", { authorization: "s3cret" })).status).toBe(200);
    expect((await get("/stats", { "x-stats-token": "s3cret" })).status).toBe(200);
  });

  it("tells a refused caller nothing about the rooms", async () => {
    store.addUserToRoom("room1", "user1", "Ada", "socket-1");

    const body = await (await get("/stats")).json();

    expect(body).toEqual(unauthorized);
  });
});
describe("POST /jobs/generate", () => {
  const submit = (body) => post("/jobs/generate", body);

  it("queues the work and answers with where to watch it", async () => {
    await boot();

    const response = await submit({
      prompt: "a login flow",
      mode: "sequence",
      roomId: "r1",
      userId: "u1",
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      success: true,
      jobId: "job-1",
      status: "queued",
      statusUrl: "/jobs/job-1",
    });
  });

  it("trims the prompt and fills in what the caller left out", async () => {
    await boot();

    await submit({ prompt: "  a house  " });

    expect(queue.enqueueGenerationJob).toHaveBeenCalledWith({
      prompt: "a house",
      scene: null,
      mode: "diagram",
      roomId: null,
      userId: null,
    });
  });

  it("carries the scene the prompt is meant to build on", async () => {
    await boot();
    const scene = [{ id: "a", type: "rectangle" }];

    await submit({ prompt: "add a label", scene });

    expect(queue.enqueueGenerationJob.mock.calls[0][0].scene).toEqual(scene);
  });
});
describe("a submission it will not queue", () => {
  const submit = (body) => post("/jobs/generate", body);

  it("refuses a request with nothing to generate from", async () => {
    await boot();

    for (const body of [{}, { prompt: "" }, { prompt: "   " }, { prompt: 42 }, undefined]) {
      const response = await submit(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "A valid prompt string is required.",
      });
    }
    expect(queue.enqueueGenerationJob).not.toHaveBeenCalled();
  });

  it("refuses a request with no parsable body at all", async () => {
    // No content type, so nothing parses it and the route sees an empty body. Its
    // own case because a request like this must read as a bad request, not as a
    // server error from reading a prompt off nothing.
    await boot();

    const response = await fetch(`${base}/jobs/generate`, { method: "POST" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A valid prompt string is required.",
    });
  });

  it("says why the queue would not take it", async () => {
    // The deployment with no REDIS_URL ends up here, and the message is the
    // queue's own: a bare 500 would leave the client with nothing to show.
    await boot();
    const message = "Redis queue is not available. Please configure REDIS_URL.";
    queue.enqueueGenerationJob.mockRejectedValue(new Error(message));

    const response = await submit({ prompt: "a house" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: message });
    expect(console.error).toHaveBeenCalledWith("Queue submission error:", message);
  });

  it("does not put a thrown non-Error in the response body", async () => {
    await boot();
    queue.enqueueGenerationJob.mockRejectedValue("some string nobody meant to send");

    const response = await submit({ prompt: "a house" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to enqueue job." });
  });
});
describe("GET /jobs/:jobId", () => {
  it("reports what the queue knows about it", async () => {
    await boot();
    const status = {
      id: "job-1",
      state: "active",
      progress: 40,
      result: null,
      error: null,
      timestamp: 1_700_000_000_000,
    };
    queue.getGenerationJob.mockResolvedValue(status);

    const response = await get("/jobs/job-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
    expect(queue.getGenerationJob).toHaveBeenCalledWith("job-1");
  });

  it("is a 404 for a job nobody has", async () => {
    // Including every job on a deployment with no queue, which is the honest
    // answer there rather than an error.
    await boot();

    const response = await get("/jobs/job-404");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Job not found." });
  });

  it("says what went wrong when the queue cannot be asked", async () => {
    await boot();
    queue.getGenerationJob.mockRejectedValue(new Error("Connection is closed."));

    const response = await get("/jobs/job-1");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Connection is closed." });
  });

  it("falls back to a message of its own for a thrown non-Error", async () => {
    await boot();
    queue.getGenerationJob.mockRejectedValue("some string nobody meant to send");

    const response = await get("/jobs/job-1");

    expect(await response.json()).toEqual({ error: "Failed to retrieve job status." });
  });
});
describe("telling a room whether its drawing is being kept", () => {
  it("registers one reporter, at boot", async () => {
    await boot();

    expect(roomState.setPersistenceReporter).toHaveBeenCalledTimes(1);
    expect(typeof reporter).toBe("function");
  });

  it("tells the room, and only that room, that the scene is durable", async () => {
    await boot();

    reporter("room1", SCENE_WRITE.SAVED);

    expect(emitted).toEqual([
      {
        roomId: "room1",
        event: "scene-persistence",
        payload: { roomId: "room1", durable: true, reason: null },
      },
    ]);
  });

  it("names the reason when the write did not land", async () => {
    // `reason` is the write outcome itself; the client renders these words, so a
    // room whose scene outgrew the column is told something different from one
    // whose database is unreachable.
    await boot();

    for (const outcome of [
      SCENE_WRITE.TOO_LARGE,
      SCENE_WRITE.UNREACHABLE,
      SCENE_WRITE.DELETED,
    ]) {
      reporter("room1", outcome);
    }

    expect(emitted.map((entry) => entry.payload)).toEqual([
      { roomId: "room1", durable: false, reason: "too-large" },
      { roomId: "room1", durable: false, reason: "unreachable" },
      { roomId: "room1", durable: false, reason: "deleted" },
    ]);
  });

  it("says nothing at all when there was no store to write to", async () => {
    // A deployment with no DATABASE_URL skips every write. Warning about the
    // operator's own choice, once per debounce per room, would be noise.
    await boot();

    reporter("room1", SCENE_WRITE.SKIPPED);

    expect(emitted).toEqual([]);
  });
});
describe("the shutdown it hands to the process", () => {
  it("is built around the io, the http server and the room flush", async () => {
    await boot();

    expect(shutdownConfig).toMatchObject({
      io: index.io,
      server: index.server,
      flushRooms: roomState.flushAllRooms,
      timeoutMs: 10_000,
    });
  });

  it("gives it everything with an open connection to let go of", async () => {
    // Named, because the sequence logs which one it is waiting on; the Postgres
    // pool comes last since the flush before them writes through it.
    await boot();

    expect(shutdownConfig.closers.map((closer) => closer.name)).toEqual([
      "the generation queue",
      "Redis",
      "the Postgres pool",
    ]);
    expect(shutdownConfig.closers[0].close).toBe(queue.closeGenerationQueue);
    expect(shutdownConfig.closers.every((closer) => typeof closer.close === "function")).toBe(
      true,
    );
  });

  it("installs the one it built, and exports it", async () => {
    // A second `createShutdown` would be a second `started` flag, and the guard
    // against a re-entrant shutdown is per-instance.
    await boot();

    expect(installed).toEqual([SHUTDOWN]);
    expect(index.shutdown).toBe(SHUTDOWN);
  });
});
