/**
 * The queue worker process: which processor it runs, at what rate, what it says
 * about the jobs it ran, and how it stops.
 *
 * Like `index.js`, this module does all of its work at require time — builds a
 * worker, subscribes to three events, installs signal handlers — so BullMQ is
 * faked at the require cache and `process.on`/`process.exit` are stubbed rather
 * than left to touch the process the test runner is using.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModuleCache } from "./helpers/moduleCache.js";

const cache = createModuleCache();

/**
 * Stands in for `./processors/defaultProcessor`, which has its own suite. All
 * this file needs is a processor it can recognise on the other side of the wiring.
 */
const defaultProcessor = async () => ({ default: true });

/** A processor on disk, so the custom-module path goes through a real require. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collabdraw-worker-"));
const customPath = path.join(tmp, "customProcessor.cjs");
fs.writeFileSync(customPath, "module.exports = async () => ({ custom: true });\n");

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The worker BullMQ would have built, and what built it. */
let worker;
let createGenerationWorker;
/** Signal handlers the module installed, kept off the real process. */
let signals;

const load = ({ processorModule = "", concurrency = "", maxPerSecond = "" } = {}) => {
  signals = new Map();
  worker = {
    listeners: new Map(),
    on: vi.fn((event, handler) => worker.listeners.set(event, handler)),
    close: vi.fn(async () => {}),
  };
  createGenerationWorker = vi.fn(() => worker);
  cache.plant("./jobs/generationQueue.js", { createGenerationWorker });
  cache.plant("./jobs/processors/defaultProcessor.js", defaultProcessor);

  vi.stubEnv("GENERATION_PROCESSOR_MODULE", processorModule);
  vi.stubEnv("QUEUE_CONCURRENCY", concurrency);
  vi.stubEnv("QUEUE_MAX_PER_SEC", maxPerSecond);

  vi.spyOn(process, "on").mockImplementation((event, handler) => {
    signals.set(event, handler);
    return process;
  });
  try {
    return cache.load("./jobs/worker.js");
  } finally {
    process.on.mockRestore();
  }
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {});
});

afterEach(() => {
  cache.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("the processor it runs", () => {
  it("uses the built-in one when nothing else is configured, and says so", () => {
    load();

    expect(createGenerationWorker.mock.calls[0][0]).toBe(defaultProcessor);
    expect(console.log).toHaveBeenCalledWith("Using default AI generation processor");
  });

  it("runs the module the deployment named", () => {
    load({ processorModule: customPath });

    expect(createGenerationWorker.mock.calls[0][0]).not.toBe(defaultProcessor);
    expect(console.log).toHaveBeenCalledWith(
      `Using custom generation processor: ${customPath}`,
    );
  });

  it("keeps working on the default when that module will not load", () => {
    // A worker that gave up here would stop draining the queue entirely. Running
    // the default still processes jobs, and the log says the override was ignored.
    load({ processorModule: "./no-such-processor" });

    expect(createGenerationWorker.mock.calls[0][0]).toBe(defaultProcessor);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load custom processor from ./no-such-processor"),
      expect.any(String),
    );
  });
});

describe("the worker it builds", () => {
  it("runs two jobs at a time, ten a second, unless told otherwise", () => {
    load();

    expect(createGenerationWorker.mock.calls[0][1]).toEqual({
      concurrency: 2,
      maxPerSecond: 10,
    });
  });

  it("takes the rate the deployment sets", () => {
    load({ concurrency: "8", maxPerSecond: "25" });

    expect(createGenerationWorker.mock.calls[0][1]).toEqual({
      concurrency: 8,
      maxPerSecond: 25,
    });
  });

  it("subscribes to the three events a stuck queue is diagnosed from", () => {
    load();

    expect([...worker.listeners.keys()]).toEqual(["completed", "failed", "error"]);
  });

  it("says it is listening only once it is", () => {
    load();

    expect(console.log).toHaveBeenLastCalledWith(
      "CollabDraw AI generation worker is running and listening for jobs",
    );
  });
});
describe("what it reports about a job", () => {
  const fire = (event, ...args) => worker.listeners.get(event)(...args);

  beforeEach(() => {
    load();
  });

  it("logs the id of a job that finished", () => {
    fire("completed", { id: "job-1" });

    expect(console.log).toHaveBeenLastCalledWith("AI generation job job-1 completed");
  });

  it("logs why a job failed", () => {
    fire("failed", { id: "job-1" }, new Error("model refused the prompt"));

    expect(console.error).toHaveBeenCalledWith(
      "AI generation job job-1 failed:",
      "model refused the prompt",
    );
  });

  it("still logs a failure that arrives with no job attached", () => {
    // BullMQ emits `failed` with an undefined job when it could not read the job
    // it was about to run; a throw in this listener would be unhandled.
    fire("failed", undefined, new Error("missing key"));

    expect(console.error).toHaveBeenCalledWith(
      "AI generation job unknown failed:",
      "missing key",
    );
  });

  it("logs an error from the worker itself", () => {
    fire("error", new Error("ECONNRESET"));

    expect(console.error).toHaveBeenCalledWith("Worker error:", "ECONNRESET");
  });
});
describe("stopping", () => {
  it("stops on either signal, with the same sequence", () => {
    // SIGINT is a local Ctrl-C, SIGTERM is the platform reclaiming the container.
    load();

    expect([...signals.keys()]).toEqual(["SIGINT", "SIGTERM"]);
    expect(signals.get("SIGINT")).toBe(signals.get("SIGTERM"));
  });

  it("closes the worker and exits clean", async () => {
    // Exit 0, or the platform records a crash and may hold off the next deploy.
    load();

    await signals.get("SIGTERM")();

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("waits for the worker, rather than cutting off a job in flight", async () => {
    // `close()` lets the active jobs finish; exiting before it settles would
    // leave them to be retried from scratch by the next worker.
    load();
    let finishClosing;
    worker.close.mockImplementation(
      () => new Promise((resolve) => (finishClosing = resolve)),
    );

    const stopping = signals.get("SIGINT")();

    expect(process.exit).not.toHaveBeenCalled();
    finishClosing();
    await stopping;

    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
