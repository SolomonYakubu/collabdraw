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

/** Write the remembered scene to Redis and Postgres, then forget it. */
async function flushRoom(roomId) {
  const shapes = latestScene.get(roomId);
  if (!shapes) return;
  latestScene.delete(roomId);

  await saveCanvasState(roomId, shapes);
  await saveBoardScene(roomId, shapes);
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
}

module.exports = {
  deleteCanvasState,
  loadCanvasState,
  saveCanvasState,
  loadBoardScene,
  scheduleFlush,
  flushRoomNow,
  flushAllRooms,
};
