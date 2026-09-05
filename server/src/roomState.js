const { getStateClient } = require("./redis");
const { saveBoardScene, loadBoardScene } = require("./db");

const ROOM_STATE_TTL_SECONDS = 24 * 60 * 60;
/** Debounce window after the last edit before the merged scene is flushed. */
const FLUSH_DEBOUNCE_MS = 3000;

const keyFor = (roomId) => `collabdraw:room:${roomId}:canvas`;

/** Persist a bounded room snapshot when Redis is available. */
async function saveCanvasState(roomId, shapes) {
  const redis = getStateClient();
  if (!redis) return;

  try {
    await redis.set(
      keyFor(roomId),
      JSON.stringify(shapes),
      "EX",
      ROOM_STATE_TTL_SECONDS,
    );
  } catch (error) {
    console.error("Redis canvas snapshot write failed:", error.message);
  }
}

/** Load a room snapshot; local memory remains the fast path. */
async function loadCanvasState(roomId) {
  const redis = getStateClient();
  if (!redis) return null;

  try {
    const value = await redis.get(keyFor(roomId));
    if (!value) return null;
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    console.error("Redis canvas snapshot read failed:", error.message);
    return null;
  }
}

async function deleteCanvasState(roomId) {
  const redis = getStateClient();
  if (!redis) return;
  await redis.del(keyFor(roomId));
}

/* ------------------------------------------------------------------ *
 * Durable flush (Redis hot cache + Postgres store of record)
 *
 * Previously every `canvas-update` re-serialised the whole room to Redis
 * (O(room) per stroke). Instead we coalesce writes: the latest merged scene
 * is remembered and flushed to both stores once edits settle, on room-empty,
 * and on shutdown.
 * ------------------------------------------------------------------ */

/** @type {Map<string, NodeJS.Timeout>} roomId -> pending flush timer */
const flushTimers = new Map();
/** @type {Map<string, Array<any>>} roomId -> the scene awaiting a flush */
const latestScene = new Map();
/**
 * @type {Set<Promise<void>>} writes started but not yet finished.
 *
 * A flush is usually started by something that cannot hold it: the debounce
 * timer fires one from a callback, and `state.js` fires one with `void` when the
 * last user leaves a room. So this is what shutdown has to wait on. Without it
 * `flushAllRooms` asks which rooms are dirty, finds that every scene has already
 * been handed to a write in flight, and reports itself finished — which is how
 * the process came to exit, and to close the pool, with the last edits of every
 * room still in the air.
 */
const inFlight = new Set();

/**
 * How a room finds out whether its work is being kept. `index.js` sets this to
 * an emit; the wiring is inverted rather than requiring the socket server here,
 * because `state.js` requires this module and the socket handlers require
 * `state.js` — and because a flush has to work in tests that have no `io` at all.
 */
let reportPersistence = () => {};

/** @param {(roomId: string, outcome: string) => void} reporter */
function setPersistenceReporter(reporter) {
  reportPersistence = typeof reporter === "function" ? reporter : () => {};
}

/** Remember the merged scene and schedule a debounced flush. Cheap per call. */
function scheduleFlush(roomId, shapes) {
  latestScene.set(roomId, shapes);
  if (flushTimers.has(roomId)) return;

  const timer = setTimeout(() => {
    flushTimers.delete(roomId);
    void flushRoom(roomId);
  }, FLUSH_DEBOUNCE_MS);
  if (typeof timer.unref === "function") timer.unref();
  flushTimers.set(roomId, timer);
}

/**
 * Write the remembered scene to Redis and Postgres, then forget it.
 *
 * Deliberately never rejects. Both stores already log their own failures, and
 * the callers that matter hold nothing — a rejection would surface as an
 * unhandled one, which for a server process means a crash instead of a line in
 * the log. It is also what lets one unreachable store not abandon the others
 * during a shutdown flush.
 */
async function flushRoom(roomId) {
  const shapes = latestScene.get(roomId);
  if (!shapes) return;
  latestScene.delete(roomId);

  const write = (async () => {
    try {
      await saveCanvasState(roomId, shapes);
      const outcome = await saveBoardScene(roomId, shapes);
      // Reported on every attempt rather than only when it changes. The
      // alternative is a per-room memory of the last outcome, which for a
      // long-lived process is a map of every room it has ever seen and nobody to
      // clean it; the client already holds the one value it cares about and only
      // speaks up when that changes. Redis is not consulted — it is the cache,
      // and losing a cache write costs nothing durable.
      reportPersistence(roomId, outcome);
    } catch (error) {
      console.error(`Room flush failed for ${roomId}:`, error.message);
    }
  })();

  inFlight.add(write);
  try {
    await write;
  } finally {
    inFlight.delete(write);
  }
}

/**
 * Wait for the writes already in flight. The loop is not paranoia: awaiting one
 * round can let a flush that started meanwhile begin, and shutdown wants the
 * stores quiet rather than merely quieter.
 */
async function drainFlushes() {
  while (inFlight.size > 0) {
    await Promise.all(inFlight);
  }
}

/** Flush immediately (room-empty / shutdown), cancelling any pending timer. */
async function flushRoomNow(roomId, shapes) {
  const timer = flushTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(roomId);
  }
  if (shapes) {
    latestScene.set(roomId, shapes);
  }
  await flushRoom(roomId);
}

/** Flush every dirty room; used on graceful shutdown. */
async function flushAllRooms() {
  const ids = new Set([...flushTimers.keys(), ...latestScene.keys()]);
  for (const timer of flushTimers.values()) clearTimeout(timer);
  flushTimers.clear();
  await Promise.all(Array.from(ids).map((id) => flushRoom(id)));
  // Then the scenes that were already handed to a write — a room that emptied a
  // moment ago, a debounce that had just fired. Those are not dirty rooms any
  // more, so the pass above cannot see them, and nobody else is waiting.
  await drainFlushes();
}

module.exports = {
  deleteCanvasState,
  loadCanvasState,
  saveCanvasState,
  loadBoardScene,
  scheduleFlush,
  setPersistenceReporter,
  flushRoomNow,
  flushAllRooms,
};
