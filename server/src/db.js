// Postgres access for the Socket.IO server (CommonJS, no build step).
//
// Mirrors the queries app/lib/db.ts needs on the server side: hydrate a room's
// scene from the durable store on join, and flush the authoritative merged
// scene back on a debounce / room-empty / shutdown.
//
// A single long-lived pool is fine here (unlike serverless); uses the pooled
// connection string.
const { Pool } = require("pg");

let pool = null;

/** Mirror of app/lib/boardAccess.ts MAX_SCENE_BYTES: reject an oversized
 *  scene before it reaches the database. */
const MAX_SCENE_BYTES = 2 * 1024 * 1024;

/**
 * Managed Postgres (Neon) requires TLS; a local server usually has no
 * certificate and refuses the handshake. A remote connection is verified;
 * sslmode=no-verify opts out. Mirrors sslForConnection() in app/lib/db.ts —
 * the two runtimes share no module.
 */
function sslFor(connectionString) {
  if (/sslmode=disable/i.test(connectionString)) return false;
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(
    connectionString,
  );
  if (isLocal) return false;
  return { rejectUnauthorized: !/sslmode=no-verify/i.test(connectionString) };
}

/** Lazily create the pool; returns null when DATABASE_URL is not configured
 *  so local dev without a database degrades to the in-memory + Redis paths. */
function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  pool = new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: 5,
    idleTimeoutMillis: 10_000,
  });
  pool.on("error", (error) => {
    console.error("Postgres pool error:", error.message);
  });
  return pool;
}

/** Load a board's durable scene. Returns an array (possibly empty) or null. */
async function loadBoardScene(boardId) {
  const db = getPool();
  if (!db) return null;
  try {
    const { rows } = await db.query(
      "select scene from boards where id = $1 and deleted_at is null",
      [boardId],
    );
    const scene = rows[0]?.scene;
    return Array.isArray(scene) ? scene : null;
  } catch (error) {
    console.error("loadBoardScene failed:", error.message);
    return null;
  }
}

/**
 * Write a room's merged scene onto an existing board row.
 *
 * Deliberately an UPDATE and not an upsert: this process has no device cookie,
 * so inserting would have to stamp a placeholder owner — and a board owned by
 * "server" is one no device can ever rename or delete. The app creates the row
 * (with the visitor's device id) while rendering /board/<id>, which always
 * happens before a client can connect a socket for that room, so there is
 * nothing to create here. A missing row means the app could not reach Postgres;
 * saying so is more useful than inventing an owner.
 */
async function saveBoardScene(boardId, shapes) {
  const db = getPool();
  if (!db) return;
  const scene = Array.isArray(shapes) ? shapes : [];
  const serialized = JSON.stringify(scene);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCENE_BYTES) {
    console.error(
      `saveBoardScene skipped: scene for ${boardId} exceeds ${MAX_SCENE_BYTES} bytes`,
    );
    return;
  }
  try {
    const result = await db.query(
      `update boards
          set scene = $2::jsonb,
              element_count = $3,
              updated_at = now()
        where id = $1
          and deleted_at is null`,
      [boardId, serialized, scene.length],
    );
    if (result.rowCount === 0) {
      console.warn(
        `saveBoardScene: no board row for ${boardId} — scene kept in Redis only`,
      );
    }
  } catch (error) {
    console.error("saveBoardScene failed:", error.message);
  }
}

async function closePool() {
  if (!pool) return;
  await pool.end().catch(() => {});
  pool = null;
}

module.exports = { getPool, loadBoardScene, saveBoardScene, closePool };
