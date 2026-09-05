/**
 * Payload guards: caps and light schema checks for client-sent data.
 *
 * The server relays collaboration data between peers, so every payload must be
 * bounded before it is stored or rebroadcast — otherwise a single malicious or
 * buggy client can exhaust memory for the whole process.
 */

/** Maximum shapes accepted in one update or full canvas state. */
const MAX_SHAPES_PER_UPDATE = 500;

/** Maximum shapes retained per room. */
const MAX_SHAPES_PER_ROOM = 2000;

/** Maximum serialized size (bytes) of one shape object. */
const MAX_SHAPE_BYTES = 32 * 1024;

/** Maximum length of user-supplied tags/names. */
const MAX_TAG_LENGTH = 64;

/** Maximum length of a room identifier. */
const MAX_ROOM_ID_LENGTH = 128;

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Keep only plain-object shapes, drop oversized entries, and cap the count.
 * Returns null when nothing usable remains.
 */
const sanitizeShapes = (shapes) => {
  if (!Array.isArray(shapes)) return null;

  const cleaned = [];
  for (const shape of shapes.slice(0, MAX_SHAPES_PER_UPDATE)) {
    if (!isPlainObject(shape)) continue;
    if (typeof shape.id !== "string" || shape.id.length > 128) continue;
    try {
      if (JSON.stringify(shape).length > MAX_SHAPE_BYTES) continue;
    } catch {
      // Circular or otherwise unserializable — reject the entry.
      continue;
    }
    cleaned.push(shape);
  }

  return cleaned.length > 0 ? cleaned : null;
};

/** Cap an array of deleted shape ids to strings of bounded length. */
const sanitizeDeletedIds = (ids) => {
  if (!Array.isArray(ids)) return null;
  const cleaned = ids
    .filter((id) => typeof id === "string" && id.length <= 128)
    .slice(0, MAX_SHAPES_PER_UPDATE);
  return cleaned.length > 0 ? cleaned : null;
};

/** Validate a room id: non-empty string of bounded length. */
const isValidRoomId = (roomId) =>
  typeof roomId === "string" &&
  roomId.length > 0 &&
  roomId.length <= MAX_ROOM_ID_LENGTH;

/**
 * Board ids the app can actually open — the same pattern
 * `app/lib/boardAccess.ts` enforces on the `/board/[id]` route (`nanoid(10)` in
 * shape, bounded because the id is a primary key).
 *
 * Narrower than `isValidRoomId` on purpose: a room id is only length-bounded, so
 * it can hold anything a client sends. That is harmless while the durable write
 * is an UPDATE and simply matches nothing, but it is not harmless once the write
 * can *create* a row — a board keyed by something `/board/<id>` would refuse to
 * open is one nobody could ever reach.
 */
const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const isValidBoardId = (id) =>
  typeof id === "string" && BOARD_ID_PATTERN.test(id);

/** Clamp a user tag to a safe display length. */
const clampTag = (tag) =>
  typeof tag === "string" ? tag.slice(0, MAX_TAG_LENGTH) : undefined;

/** Clamp a coordinate to a finite number. */
const clampCoordinate = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(-1e6, Math.min(1e6, value))
    : undefined;

module.exports = {
  MAX_SHAPES_PER_ROOM,
  MAX_SHAPES_PER_UPDATE,
  clampCoordinate,
  clampTag,
  isValidBoardId,
  isValidRoomId,
  sanitizeDeletedIds,
  sanitizeShapes,
};
