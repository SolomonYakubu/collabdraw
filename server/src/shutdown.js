/**
 * Graceful shutdown.
 *
 * A room's scene lives in memory and is written on a debounce, so an exit that
 * does not wait for those writes loses up to `FLUSH_DEBOUNCE_MS` of everybody's
 * drawing. Four things made that likely rather than theoretical:
 *
 *  - **The flushes nobody holds.** `io.close()` disconnects every socket, and
 *    the last one out of a room starts a flush that `state.js` fires with
 *    `void`. Asking which rooms are still dirty finds nothing — the scene is
 *    handed to the write and forgotten in the same synchronous step — so
 *    `flushAllRooms` waits for the writes in flight as well.
 *  - **Nothing bounded the sequence.** `httpServer.close()` waits for the
 *    connections it is still serving, so one request that never finishes — or,
 *    on Node 18, one idle keep-alive from an uptime monitor polling `/stats` —
 *    is enough to hold shutdown open until the platform loses patience and sends
 *    `SIGKILL`, taking every unwritten scene with it. Hence a deadline, and
 *    hence ending the idle connections rather than waiting for them.
 *  - **A second signal re-entered the whole thing**, closing the pool
 *    underneath the writes the first one was waiting for.
 *  - **A throw nobody caught exited with no flush at all**, there being no
 *    `uncaughtException` handler anywhere in the server.
 *
 * The order below is the point: everything durable is written before anything
 * that can hang, so the deadline can only ever cost bookkeeping.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @param {object} deps
 * @param {{ close: () => Promise<void> }} deps.io the Socket.IO server
 * @param {import("http").Server} deps.server the HTTP server it is attached to
 * @param {() => Promise<void>} deps.flushRooms usually `flushAllRooms`
 * @param {Array<{ name: string, close: () => Promise<unknown> }>} [deps.closers]
 *   connection pools, in the order they should be let go — after the flush, or
 *   the flush has nothing to write with.
 * @param {number} [deps.timeoutMs]
 * @param {(code: number) => void} [deps.exit] seam for the tests, which would
 *   otherwise take the test runner down with them.
 * @returns {(reason: string, code?: number) => Promise<void>}
 */
function createShutdown({
  io,
  server,
  flushRooms,
  closers = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  exit = (code) => process.exit(code),
}) {
  let started = false;

  return async function shutdown(reason, code = 0) {
    if (started) {
      // Re-entering would close the stores under the first pass's writes. The
      // deadline below is what answers an operator who is out of patience.
      console.log(`Shutdown already in progress; ignoring ${reason}.`);
      return;
    }
    started = true;
    console.log(`Shutting down CollabDraw Socket.IO server (${reason})...`);

    /** Named so an expiry can say what it was waiting for. */
    let stage = "closing connections";
    // Deliberately not unref'd: if the sequence stalls on a socket that will
    // not close, this timer is the only thing left that has to fire.
    const deadline = setTimeout(() => {
      console.error(
        `Shutdown stalled while ${stage} after ${timeoutMs}ms; exiting anyway.`,
      );
      exit(1);
    }, timeoutMs);

    let exitCode = code;

    try {
      // Stops new connections and disconnects the live ones — which is what
      // produces the final room-empty flushes. Socket.IO runs those disconnect
      // handlers before this promise's first await, so the flush below already
      // sees the writes they started.
      const closed = io.close();

      // Socket.IO ends the sockets it owns; a plain HTTP keep-alive is not one
      // of them. Current Node ends the idle ones inside `close()` itself, but
      // 18.x waits for them — which is how a monitor polling `/stats` could hold
      // shutdown open — so ask explicitly where the method exists (18.2+).
      // What neither can help with is a request still being served; that is the
      // deadline's job.
      if (typeof server.closeIdleConnections === "function") {
        server.closeIdleConnections();
      }

      stage = "writing room scenes";
      await flushRooms().catch((error) => {
        console.error("Room flush during shutdown failed:", error.message);
      });

      for (const closer of closers) {
        stage = `closing ${closer.name}`;
        await Promise.resolve(closer.close()).catch((error) => {
          console.error(`Failed to close ${closer.name}:`, error.message);
        });
      }

      stage = "waiting for connections to end";
      await closed;
      console.log("Server has been closed");
    } catch (error) {
      console.error("Shutdown failed:", error && error.message);
      if (exitCode === 0) exitCode = 1;
    }

    clearTimeout(deadline);
    exit(exitCode);
  };
}

/**
 * Register the process-level handlers. `process` is a parameter so a test can
 * hand in an emitter of its own instead of hijacking the runner's signals.
 *
 * @param {(reason: string, code?: number) => Promise<void>} shutdown
 * @param {{ process?: NodeJS.EventEmitter }} [options]
 */
function installShutdownHandlers(shutdown, { process: proc = process } = {}) {
  // SIGINT for local dev, SIGTERM for cloud containers.
  proc.on("SIGINT", () => void shutdown("SIGINT"));
  proc.on("SIGTERM", () => void shutdown("SIGTERM"));

  /*
   * A throw nobody caught leaves the process in an undefined state, so the only
   * useful thing left to do with it is write the scenes and go. Same sequence,
   * non-zero code — restarting is the supervisor's business, not ours.
   */
  proc.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", (error && error.stack) || error);
    void shutdown("uncaughtException", 1);
  });
  proc.on("unhandledRejection", (reason) => {
    console.error(
      "Unhandled rejection:",
      (reason && reason.stack) || reason,
    );
    void shutdown("unhandledRejection", 1);
  });
}

module.exports = { DEFAULT_TIMEOUT_MS, createShutdown, installShutdownHandlers };
