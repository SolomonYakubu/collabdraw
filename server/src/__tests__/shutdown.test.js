/**
 * Shutdown is a sequence, and every bug it had was an ordering bug: writing the
 * scenes after the thing that hangs, closing the pool over the top of a write,
 * or not writing at all. So most of what follows asserts *order* — a shared log
 * that each fake step appends to.
 *
 * `exit` and `process` are both injected, because a test that really exits or
 * really registers a SIGINT handler takes the runner with it.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodeRequire = createRequire(import.meta.url);
const { createShutdown, installShutdownHandlers } = nodeRequire("../shutdown.js");

/** A promise that only settles when the test says so. */
const gate = () => {
  let open;
  const held = new Promise((resolve) => {
    open = resolve;
  });
  return { held, open: () => open() };
};

/**
 * The pieces of the real wiring, each logging when it runs. `io.close()` returns
 * a promise the way Socket.IO's does, and resolving it is what "the connections
 * have ended" means.
 */
const harness = (overrides = {}) => {
  const log = [];
  const connections = gate();
  const exits = [];

  const deps = {
    io: {
      close: vi.fn(() => {
        log.push("io.close");
        return connections.held;
      }),
    },
    server: {
      closeIdleConnections: vi.fn(() => log.push("closeIdleConnections")),
    },
    flushRooms: vi.fn(async () => {
      log.push("flush");
    }),
    closers: [
      { name: "Redis", close: vi.fn(async () => log.push("close:Redis")) },
      { name: "the Postgres pool", close: vi.fn(async () => log.push("close:pool")) },
    ],
    timeoutMs: 10_000,
    exit: (code) => {
      log.push(`exit:${code}`);
      exits.push(code);
    },
    ...overrides,
  };

  return { log, exits, connections, deps, shutdown: createShutdown(deps) };
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the sequence", () => {
  it("writes the scenes before it closes the stores, and exits 0", async () => {
    const { log, shutdown, connections } = harness();

    const done = shutdown("SIGTERM");
    connections.open();
    await done;

    expect(log).toEqual([
      // Disconnecting everyone is what produces the last flushes, so it comes
      // first; ending the idle keep-alives is what lets `close` finish at all.
      "io.close",
      "closeIdleConnections",
      "flush",
      "close:Redis",
      "close:pool",
      "exit:0",
    ]);
  });

  it("does not wait for the connections to end before writing", async () => {
    // The reason the order above is not just tidiness: a keep-alive that never
    // closes must not be able to cost anybody their drawing.
    const { log, shutdown } = harness();

    shutdown("SIGTERM");
    await vi.waitFor(() => expect(log).toContain("close:pool"));

    // …all of that with `io.close()`'s promise still pending.
    expect(log).not.toContain("exit:0");
  });

  it("closes the stores in the order it was given them", async () => {
    const { log, shutdown, connections } = harness();

    const done = shutdown("SIGTERM");
    connections.open();
    await done;

    expect(log.indexOf("close:Redis")).toBeLessThan(log.indexOf("close:pool"));
  });

  it("survives a server with no closeIdleConnections", async () => {
    // Node grew the method in 18.2, and the project asks only for 18.0.
    const { log, shutdown, connections } = harness({ server: {} });

    const done = shutdown("SIGTERM");
    connections.open();
    await done;

    expect(log).toEqual(["io.close", "flush", "close:Redis", "close:pool", "exit:0"]);
  });
});

describe("when something fails", () => {
  it("still closes the stores when the flush throws", async () => {
    const { log, shutdown, connections } = harness({
      flushRooms: vi.fn(async () => {
        throw new Error("pool is ending");
      }),
    });

    const done = shutdown("SIGTERM");
    connections.open();
    await done;

    expect(log).toEqual([
      "io.close",
      "closeIdleConnections",
      "close:Redis",
      "close:pool",
      "exit:0",
    ]);
  });

  it("keeps going when one store will not close", async () => {
    const { log, shutdown, connections } = harness({
      closers: [
        {
          name: "Redis",
          close: vi.fn(async () => {
            throw new Error("connection is closed");
          }),
        },
        { name: "the Postgres pool", close: vi.fn(async () => log.push("close:pool")) },
      ],
    });

    const done = shutdown("SIGTERM");
    connections.open();
    await done;

    expect(log).toContain("close:pool");
    expect(log).toContain("exit:0");
  });
  it("finishes the sequence when the connections end badly, and exits 1", async () => {
    // `io.close()`'s promise is awaited last, after the flush and the closers, so
    // a rejection there costs nothing that mattered. The exit code still has to
    // say it was not a clean stop, or the platform records a successful one.
    const { log, exits, shutdown } = harness({
      io: {
        close: vi.fn(() => {
          log.push("io.close");
          return Promise.reject(new Error("engine closed abruptly"));
        }),
      },
    });

    await shutdown("SIGTERM");

    expect(log).toEqual([
      "io.close",
      "closeIdleConnections",
      "flush",
      "close:Redis",
      "close:pool",
      "exit:1",
    ]);
    expect(exits).toEqual([1]);
    expect(console.error).toHaveBeenCalledWith(
      "Shutdown failed:",
      "engine closed abruptly",
    );
  });
});

describe("the deadline", () => {
  it("exits anyway when the connections never end", async () => {
    vi.useFakeTimers();
    const { log, shutdown } = harness({ timeoutMs: 5_000 });

    void shutdown("SIGTERM"); // `io.close()`'s promise is never resolved
    await vi.advanceTimersByTimeAsync(4_999);
    expect(log).not.toContain("exit:1");

    await vi.advanceTimersByTimeAsync(1);
    expect(log).toContain("exit:1");
  });

  it("says which step it was stuck on", async () => {
    vi.useFakeTimers();
    const { shutdown } = harness({ timeoutMs: 5_000 });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("waiting for connections to end"),
    );
  });

  it("names the flush when that is what stalled", async () => {
    vi.useFakeTimers();
    const stuck = gate();
    const { shutdown } = harness({
      timeoutMs: 5_000,
      flushRooms: vi.fn(() => stuck.held),
    });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("writing room scenes"),
    );
  });

  it("does not fire once the sequence has finished", async () => {
    vi.useFakeTimers();
    const { exits, shutdown, connections } = harness({ timeoutMs: 5_000 });

    const done = shutdown("SIGTERM");
    connections.open();
    await done;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(exits).toEqual([0]);
  });
});

describe("a second signal", () => {
  it("is ignored while the first is still going", async () => {
    const { log, shutdown, connections, deps } = harness();

    const first = shutdown("SIGTERM");
    await shutdown("SIGINT"); // an operator out of patience
    connections.open();
    await first;

    expect(deps.io.close).toHaveBeenCalledTimes(1);
    expect(deps.flushRooms).toHaveBeenCalledTimes(1);
    // Re-entering would have closed the pool underneath the first pass's writes.
    expect(log.filter((entry) => entry === "close:pool")).toHaveLength(1);
    expect(log.filter((entry) => entry.startsWith("exit:"))).toHaveLength(1);
  });

  it("is ignored after the first has finished, too", async () => {
    const { exits, shutdown, connections } = harness();

    const done = shutdown("SIGTERM");
    connections.open();
    await done;
    await shutdown("SIGINT");

    expect(exits).toEqual([0]);
  });
});

describe("the process handlers", () => {
  /** A stand-in for `process`, so the runner's own signals are left alone. */
  const install = () => {
    const proc = new EventEmitter();
    const shutdown = vi.fn(async () => {});
    installShutdownHandlers(shutdown, { process: proc });
    return { proc, shutdown };
  };

  it("shuts down on SIGTERM and SIGINT, successfully", () => {
    const { proc, shutdown } = install();

    proc.emit("SIGTERM");
    proc.emit("SIGINT");

    expect(shutdown.mock.calls).toEqual([["SIGTERM"], ["SIGINT"]]);
  });

  it("flushes on an uncaught exception, and exits non-zero", () => {
    // The case that used to lose everything: a throw in a handler exited with
    // no flush at all, because nothing was listening for it.
    const { proc, shutdown } = install();

    proc.emit("uncaughtException", new Error("boom"));

    expect(shutdown).toHaveBeenCalledWith("uncaughtException", 1);
  });

  it("flushes on an unhandled rejection, and exits non-zero", () => {
    const { proc, shutdown } = install();

    proc.emit("unhandledRejection", new Error("boom"));

    expect(shutdown).toHaveBeenCalledWith("unhandledRejection", 1);
  });

  it("logs a rejection that is not an Error at all", () => {
    const { proc } = install();

    proc.emit("unhandledRejection", "just a string");

    expect(console.error).toHaveBeenCalledWith(
      "Unhandled rejection:",
      "just a string",
    );
  });
});
