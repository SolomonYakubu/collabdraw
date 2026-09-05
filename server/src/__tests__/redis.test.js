/**
 * The Redis clients, and the deployments that have none.
 *
 * Redis is optional here: without it the server keeps room state in memory and a
 * single instance works fine. That makes this module mostly about the difference
 * between "not configured" and "misconfigured" — the first is a warning and a
 * null, the second has to be a fast, loud failure, because a production cluster
 * that quietly runs without a shared adapter splits every room in two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModuleCache } from "./helpers/moduleCache.js";

const cache = createModuleCache();

/** Every client the module constructed or duplicated, in order. */
let clients;
/** What `createAdapter` was called with, and the sentinel it returned. */
let adapterCalls;
const ADAPTER = Symbol("redis adapter");

const load = ({ redisUrl = "", requireRedis = false } = {}) => {
  clients = [];
  adapterCalls = [];

  cache.plant("./config.js", { redisUrl, requireRedis });

  cache.plant(
    "ioredis",
    class FakeRedis {
      constructor(url, options) {
        this.url = url;
        this.options = options;
        this.handlers = {};
        this.on = vi.fn((event, handler) => {
          this.handlers[event] = handler;
        });
        this.quit = vi.fn(async () => "OK");
        this.duplicate = vi.fn(() => new FakeRedis(url, options));
        clients.push(this);
      }
    },
  );

  cache.plant("@socket.io/redis-adapter", {
    createAdapter: vi.fn((pub, sub) => {
      adapterCalls.push({ pub, sub });
      return ADAPTER;
    }),
  });

  return cache.load("./redis.js");
};

let redis;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cache.reset();
  vi.restoreAllMocks();
});
describe("a deployment with no Redis", () => {
  beforeEach(() => {
    redis = load();
  });

  it("says so, and carries on in memory", () => {
    expect(redis.initRedis()).toBeNull();
    expect(clients).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      "REDIS_URL is not configured; using in-memory state",
    );
  });

  it("has no client for the room snapshots", () => {
    // `roomState` asks for this before every snapshot write and skips the write
    // when it is null, which is how the local dev server stays quiet.
    redis.initRedis();

    expect(redis.getStateClient()).toBeNull();
  });

  it("has nothing to close", async () => {
    await expect(redis.closeRedis()).resolves.toBeUndefined();
  });

  it("leaves the adapter alone, so Socket.IO keeps its in-memory one", () => {
    const io = { adapter: vi.fn() };

    redis.configureSocketAdapter(io, redis.initRedis());

    expect(io.adapter).not.toHaveBeenCalled();
  });
});

describe("a deployment that requires Redis and has none", () => {
  it("refuses to start", () => {
    // The failure has to happen here, at boot. A cluster that starts without the
    // shared adapter puts half the room on one instance and half on another, and
    // each half sees the other as offline.
    redis = load({ requireRedis: true });

    expect(() => redis.initRedis()).toThrow(
      "REDIS_URL is required when REQUIRE_REDIS=true",
    );
  });
});
describe("a deployment with Redis", () => {
  const url = "redis://cache:6379";

  beforeEach(() => {
    redis = load({ redisUrl: url });
  });

  it("opens three connections from one URL", () => {
    // Publisher, subscriber and one for room snapshots. The adapter's two cannot
    // be shared — a subscriber connection can do nothing else — and borrowing
    // either for snapshot writes would block them behind a stroke.
    const built = redis.initRedis();

    expect(Object.keys(built)).toEqual(["pub", "sub", "state"]);
    expect(clients).toHaveLength(3);
    expect(clients[0].duplicate).toHaveBeenCalledTimes(2);
    expect(clients.every((client) => client.url === url)).toBe(true);
  });

  it("asks ioredis not to give up on a command", () => {
    redis.initRedis();

    expect(clients[0].options).toEqual({
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  });

  it("hands the room snapshots their own client", () => {
    const built = redis.initRedis();

    expect(redis.getStateClient()).toBe(built.state);
  });

  it("listens for errors on all three, so one cannot take the process down", () => {
    // An ioredis client with no `error` listener throws on a dropped connection,
    // and an unhandled `error` event is a crash — during a deploy of the Redis
    // service, on a server holding every open room.
    redis.initRedis();

    for (const client of clients) {
      expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
    }
  });

  it("logs a connection error rather than rethrowing it", () => {
    redis.initRedis();

    clients[0].handlers.error(new Error("ECONNREFUSED"));

    expect(console.error).toHaveBeenCalledWith(
      "Redis connection error:",
      "ECONNREFUSED",
    );
  });

  it("closes all three on the way out", async () => {
    redis.initRedis();

    await redis.closeRedis();

    for (const client of clients) {
      expect(client.quit).toHaveBeenCalledTimes(1);
    }
  });

  it("gives Socket.IO the shared adapter, built from the two it is for", () => {
    const io = { adapter: vi.fn() };
    const built = redis.initRedis();

    redis.configureSocketAdapter(io, built);

    expect(adapterCalls).toEqual([{ pub: built.pub, sub: built.sub }]);
    expect(io.adapter).toHaveBeenCalledWith(ADAPTER);
  });
});
