/**
 * The AI generation queue: the durable half of "draw me a diagram".
 *
 * Nothing here talks to a model. It is BullMQ wiring, and the wiring is where the
 * mistakes live — a queue and its event stream sharing one Redis connection, a
 * job added under a name no worker listens for, or a `close()` that leaves the
 * memoised instance in place so the next enqueue writes to a closed connection.
 * BullMQ and ioredis are both faked, so no test opens a socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModuleCache } from "./helpers/moduleCache.js";

const cache = createModuleCache();

/** Everything the module built, in the order it built it. */
let queues;
let events;
let workers;
let connections;

/** The job BullMQ hands back from `add`, and `getJob` finds. */
let stored;

const load = ({ redisUrl = "redis://localhost:6379" } = {}) => {
  queues = [];
  events = [];
  workers = [];
  connections = [];
  stored = null;

  cache.plant("./config.js", { redisUrl });

  cache.plant(
    "ioredis",
    class FakeRedis {
      constructor(url, options) {
        this.url = url;
        this.options = options;
        connections.push(this);
      }
    },
  );

  cache.plant("bullmq", {
    Queue: class FakeQueue {
      constructor(name, options) {
        this.name = name;
        this.options = options;
        this.add = vi.fn(async (jobName, data, jobOptions) => ({
          id: "job-1",
          name: jobName,
          timestamp: 1_700_000_000_000,
          data,
          jobOptions,
        }));
        this.getJob = vi.fn(async () => stored);
        this.close = vi.fn(async () => {});
        queues.push(this);
      }
    },
    QueueEvents: class FakeQueueEvents {
      constructor(name, options) {
        this.name = name;
        this.options = options;
        this.close = vi.fn(async () => {});
        events.push(this);
      }
    },
    Worker: class FakeWorker {
      constructor(name, processor, options) {
        this.name = name;
        this.processor = processor;
        this.options = options;
        workers.push(this);
      }
    },
  });

  return cache.load("./jobs/generationQueue.js");
};

let queueModule;

beforeEach(() => {
  queueModule = load();
});

afterEach(() => {
  cache.reset();
  vi.restoreAllMocks();
});
describe("the queue itself", () => {
  it("is absent when Redis is not configured", () => {
    // No Redis is a supported deployment: the app still draws and collaborates,
    // and background generation is simply unavailable.
    queueModule = load({ redisUrl: "" });

    expect(queueModule.getGenerationQueue()).toBeNull();
    expect(queues).toEqual([]);
    expect(connections).toEqual([]);
  });

  it("is built once and reused", () => {
    const first = queueModule.getGenerationQueue();
    const second = queueModule.getGenerationQueue();

    expect(second).toBe(first);
    expect(queues).toHaveLength(1);
  });

  it("carries the name the worker listens on", () => {
    queueModule.getGenerationQueue();

    expect(queueModule.QUEUE_NAME).toBe("collabdraw:ai-generation");
    expect(queues[0].name).toBe(queueModule.QUEUE_NAME);
    expect(events[0].name).toBe(queueModule.QUEUE_NAME);
  });

  it("gives the queue and its event stream separate connections", () => {
    // A `QueueEvents` stream blocks on its connection; sharing one with the queue
    // is how an enqueue comes to hang behind an event subscription.
    queueModule.getGenerationQueue();

    expect(connections).toHaveLength(2);
    expect(queues[0].options.connection).not.toBe(events[0].options.connection);
  });

  it("asks ioredis not to give up on a command", () => {
    // BullMQ requires `maxRetriesPerRequest: null`; with a finite count a blocking
    // command fails during a reconnect and takes the worker with it.
    queueModule.getGenerationQueue();

    expect(connections[0].url).toBe("redis://localhost:6379");
    expect(connections[0].options).toEqual({ maxRetriesPerRequest: null });
  });

  it("retries a failed job three times, backing off, and forgets old ones", () => {
    queueModule.getGenerationQueue();

    expect(queues[0].options.defaultJobOptions).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    });
  });
});
describe("enqueueing", () => {
  const request = {
    prompt: "a login flow",
    scene: null,
    mode: "sequence",
    roomId: "r1",
    userId: "u1",
  };

  it("says why it cannot, rather than failing obscurely", async () => {
    // This message reaches the client as the 500 body from `/jobs/generate`, so it
    // has to name the missing configuration.
    queueModule = load({ redisUrl: "" });

    await expect(queueModule.enqueueGenerationJob(request)).rejects.toThrow(
      "Redis queue is not available. Please configure REDIS_URL.",
    );
  });

  it("adds the job under the name the worker processes", async () => {
    await queueModule.enqueueGenerationJob(request);

    expect(queues[0].add).toHaveBeenCalledWith("generate-drawing", request, {
      priority: 5,
    });
  });

  it("takes the caller's priority when there is one", async () => {
    await queueModule.enqueueGenerationJob({ ...request, priority: 1 });

    expect(queues[0].add.mock.calls[0][2]).toEqual({ priority: 1 });
  });

  it("answers with the ticket, not the whole job", async () => {
    // The job holds the scene that was sent with it; echoing it back would double
    // the payload of every submission for nothing.
    const ticket = await queueModule.enqueueGenerationJob(request);

    expect(ticket).toEqual({
      id: "job-1",
      name: "generate-drawing",
      timestamp: 1_700_000_000_000,
    });
  });
});
describe("asking after a job", () => {
  /** What BullMQ holds for a job that has run. */
  const bullJob = (extra = {}) => ({
    id: "job-1",
    progress: 40,
    timestamp: 1_700_000_000_000,
    getState: vi.fn(async () => "active"),
    ...extra,
  });

  it("answers with nothing when there is no queue to ask", async () => {
    // Not a throw: `/jobs/:jobId` turns this into a 404, which is the honest
    // answer on a deployment that never queued anything.
    queueModule = load({ redisUrl: "" });

    await expect(queueModule.getGenerationJob("job-1")).resolves.toBeNull();
  });

  it("answers with nothing for an id nobody has", async () => {
    stored = null;

    await expect(queueModule.getGenerationJob("job-404")).resolves.toBeNull();
  });

  it("reports where the job got to", async () => {
    stored = bullJob({
      progress: 100,
      returnvalue: { summary: "done" },
      getState: vi.fn(async () => "completed"),
    });

    await expect(queueModule.getGenerationJob("job-1")).resolves.toEqual({
      id: "job-1",
      state: "completed",
      progress: 100,
      result: { summary: "done" },
      error: null,
      timestamp: 1_700_000_000_000,
    });
  });

  it("reports why it failed", async () => {
    stored = bullJob({
      failedReason: "Job payload must contain a valid prompt string.",
      getState: vi.fn(async () => "failed"),
    });

    const status = await queueModule.getGenerationJob("job-1");

    expect(status).toMatchObject({
      state: "failed",
      error: "Job payload must contain a valid prompt string.",
      result: null,
    });
  });

  it("says null rather than nothing at all for a job still running", async () => {
    // `undefined` would drop the keys from the JSON response, and the client polls
    // the same shape whatever state the job is in.
    stored = bullJob();

    const status = await queueModule.getGenerationJob("job-1");

    expect(status.result).toBeNull();
    expect(status.error).toBeNull();
  });
});
describe("closing, which shutdown waits on", () => {
  it("closes the queue and its event stream", async () => {
    queueModule.getGenerationQueue();

    await queueModule.closeGenerationQueue();

    expect(queues[0].close).toHaveBeenCalledTimes(1);
    expect(events[0].close).toHaveBeenCalledTimes(1);
  });

  it("has nothing to close before anything was built", async () => {
    // Shutdown closes the queue unconditionally, including on a deployment that
    // never configured Redis.
    await expect(queueModule.closeGenerationQueue()).resolves.toBeUndefined();
    expect(queues).toEqual([]);
  });

  it("forgets what it closed, rather than handing it out again", async () => {
    // The memoised instance is the whole risk here: kept after `close()`, the next
    // enqueue would add to a queue whose connection is gone.
    const first = queueModule.getGenerationQueue();
    await queueModule.closeGenerationQueue();

    const second = queueModule.getGenerationQueue();

    expect(second).not.toBe(first);
    expect(queues).toHaveLength(2);
  });
});

describe("what the worker process builds", () => {
  it("hands back a queue and the event stream beside it", () => {
    const built = queueModule.createGenerationQueue();

    expect(built.queue).toBe(queues[0]);
    expect(built.events).toBe(events[0]);
  });

  it("runs the processor at a bounded rate", async () => {
    const processor = async () => {};

    queueModule.createGenerationWorker(processor);

    expect(workers[0].name).toBe(queueModule.QUEUE_NAME);
    expect(workers[0].processor).toBe(processor);
    expect(workers[0].options).toMatchObject({
      concurrency: 2,
      limiter: { max: 10, duration: 1_000 },
    });
  });

  it("takes the concurrency and rate the worker asks for", () => {
    queueModule.createGenerationWorker(async () => {}, {
      concurrency: 8,
      maxPerSecond: 25,
    });

    expect(workers[0].options).toMatchObject({
      concurrency: 8,
      limiter: { max: 25, duration: 1_000 },
    });
  });

  it("refuses to build either one without Redis", () => {
    queueModule = load({ redisUrl: "" });

    const message = "REDIS_URL is required to use the AI generation queue";
    expect(() => queueModule.createGenerationQueue()).toThrow(message);
    expect(() => queueModule.createGenerationWorker(async () => {})).toThrow(message);
  });
});
