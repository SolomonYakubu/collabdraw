const { getStateClient } = require("./redis");

const ROOM_STATE_TTL_SECONDS = 24 * 60 * 60;

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

module.exports = { deleteCanvasState, loadCanvasState, saveCanvasState };