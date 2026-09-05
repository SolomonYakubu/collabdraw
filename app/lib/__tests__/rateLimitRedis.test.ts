/**
 * The rate limiter with `REDIS_URL` configured — the only configuration that
 * limits anything on a deployment running more than one instance.
 *
 * In memory, every instance counts separately, so N instances multiply every
 * ceiling by N; the Redis path is what makes `generate-drawing`'s 5-a-minute
 * mean five. It has to hold two properties that are invisible from the return
 * value: the window has to be *fixed*, not extended by each request, and a Redis
 * that is unreachable has to degrade to the local count instead of failing the
 * request — the limiter is on the path of every AI generation and every board
 * create, so an exception here takes those routes down with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in for `ioredis`, recording what the limiter asked it to do. */
const redis = vi.hoisted(() => {
  const state = {
    created: [] as { url: string; options: Record<string, unknown> }[],
    connects: 0,
    listeners: new Map<string, (error: Error) => void>(),
    commands: [] as unknown[][],
    status: "wait",
    connectFails: false,
    exec: async (): Promise<unknown> => [[null, 1]],
  };

  class FakeRedis {
    constructor(url: string, options: Record<string, unknown>) {
      state.created.push({ url, options });
    }
    get status() {
      return state.status;
    }
    async connect() {
      state.connects += 1;
      if (state.connectFails) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      }
      state.status = "ready";
    }
    on(event: string, handler: (error: Error) => void) {
      state.listeners.set(event, handler);
      return this;
    }
    pipeline() {
      const chain = {
        incr: (key: string) => {
          state.commands.push(["incr", key]);
          return chain;
        },
        expire: (...args: unknown[]) => {
          state.commands.push(["expire", ...args]);
          return chain;
        },
        exec: () => {
          if (state.status !== "ready") {
            // What ioredis does with a socket that never came up.
            throw new Error("Stream isn't writeable and enableOfflineQueue is false");
          }
          return state.exec();
        },
      };
      return chain;
    }
  }

  return { state, FakeRedis };
});

vi.mock("ioredis", () => ({ default: redis.FakeRedis }));

/**
 * A fresh copy of the limiter: it caches its client in module scope, which is
 * the behaviour under test in one case and in the way of every other.
 */
const load = async () => {
  vi.resetModules();
  return (await import("../rateLimit")).isAllowedRateLimit;
};

/** What `incr` returned — the count this request is. */
const counted = (count: number) => {
  redis.state.exec = async () => [[null, count]];
};

beforeEach(() => {
  vi.stubEnv("REDIS_URL", "rediss://default:token@eu2-cool-name.upstash.io:6379");
  redis.state.created.length = 0;
  redis.state.commands.length = 0;
  redis.state.listeners.clear();
  redis.state.connects = 0;
  redis.state.status = "wait";
  redis.state.connectFails = false;
  counted(1);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("counting in Redis", () => {
  it("increments a namespaced key and expires it only once per window", async () => {
    // `NX` is the whole fixed-window rule: without it every request re-arms the
    // TTL, so a caller who keeps knocking is never let back in.
    const isAllowed = await load();

    await isAllowed("ai-generate:203.0.113.7", 5, 60);

    expect(redis.state.commands).toEqual([
      ["incr", "collabdraw:ratelimit:ai-generate:203.0.113.7"],
      ["expire", "collabdraw:ratelimit:ai-generate:203.0.113.7", 60, "NX"],
    ]);
  });

  it("allows the request that reaches the limit and blocks the next", async () => {
    const isAllowed = await load();

    counted(5);
    expect(await isAllowed("k", 5, 60)).toBe(true);
    counted(6);
    expect(await isAllowed("k", 5, 60)).toBe(false);
  });

  it("connects a lazily-created client, then leaves it connected", async () => {
    // `lazyConnect` keeps a build or a cold start from dialling Redis; the first
    // limited request is what opens the socket.
    const isAllowed = await load();

    await isAllowed("k", 5, 60);
    await isAllowed("k", 5, 60);

    expect(redis.state.connects).toBe(1);
    expect(redis.state.created).toHaveLength(1);
  });

  it("builds the client to fail fast rather than hang the request", async () => {
    // Every option here is about latency: a request waiting on Redis is a request
    // the visitor is waiting on too.
    const isAllowed = await load();
    await isAllowed("k", 5, 60);

    const { url, options } = redis.state.created[0];
    expect(url).toBe("rediss://default:token@eu2-cool-name.upstash.io:6379");
    expect(options.maxRetriesPerRequest).toBe(1);
    expect(options.enableReadyCheck).toBe(false);
    expect(options.lazyConnect).toBe(true);
  });

  it("gives up reconnecting rather than retrying forever", async () => {
    const isAllowed = await load();
    await isAllowed("k", 5, 60);

    const retry = redis.state.created[0].options.retryStrategy as (
      times: number,
    ) => number | null;
    expect(retry(1)).toBe(100);
    expect(retry(3)).toBe(300);
    // Backed off, then stopped: a wrong URL should not have every instance
    // dialling it for the lifetime of the process.
    expect(retry(4)).toBeNull();
  });

  it("logs a connection error instead of letting it end the process", async () => {
    // An `error` event with no listener is fatal in Node, and ioredis emits one
    // per failed reconnection attempt.
    const isAllowed = await load();
    await isAllowed("k", 5, 60);

    const onError = redis.state.listeners.get("error");
    expect(onError).toBeTypeOf("function");
    expect(() => onError?.(new Error("ETIMEDOUT"))).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(
      "Redis rate-limiter connection error:",
      "ETIMEDOUT",
    );
  });
});

describe("when Redis cannot answer", () => {
  it("counts locally instead of failing the request", async () => {
    // The limiter is in front of the AI route and board creation; an exception
    // here would turn a Redis outage into an outage of both.
    const isAllowed = await load();
    redis.state.exec = async () => {
      throw new Error("Command timed out");
    };

    expect(await isAllowed("local-fallback", 2, 60)).toBe(true);
    expect(await isAllowed("local-fallback", 2, 60)).toBe(true);
    // Still limiting — just per instance.
    expect(await isAllowed("local-fallback", 2, 60)).toBe(false);
  });

  it("counts locally when the pipeline answers with something unusable", async () => {
    const isAllowed = await load();

    for (const answer of [null, [], [[new Error("NOSCRIPT"), null]], [[null, "1"]]]) {
      redis.state.exec = async () => answer;
      expect(await isAllowed(`unusable-${String(answer)}`, 1, 60)).toBe(true);
    }
  });

  it("carries on when the connection attempt itself fails", async () => {
    const isAllowed = await load();
    redis.state.connectFails = true;

    expect(await isAllowed("connect-fails", 1, 60)).toBe(true);
    expect(await isAllowed("connect-fails", 1, 60)).toBe(false);
  });

  it("does not touch Redis at all when no URL is configured", async () => {
    vi.stubEnv("REDIS_URL", "");
    const isAllowed = await load();

    expect(await isAllowed("no-url", 1, 60)).toBe(true);
    expect(redis.state.created).toEqual([]);
  });
});
