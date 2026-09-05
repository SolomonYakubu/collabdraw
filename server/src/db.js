// Postgres access for the Socket.IO server (CommonJS, no build step).
//
// Mirrors the queries app/lib/db.ts needs on the server side: hydrate a room's
// scene from the durable store on join, and flush the authoritative merged
// scene back on a debounce / room-empty / shutdown.
//
// A single long-lived pool is fine here (unlike serverless); uses the pooled
// connection string.
const { Pool } = require("pg");
const { isValidBoardId } = require("./validation");

let pool = null;

/** Mirror of app/lib/boardAccess.ts MAX_SCENE_BYTES: reject an oversized
 *  scene before it reaches the database. */
const MAX_SCENE_BYTES = 2 * 1024 * 1024;

/**
 * The owner stamped on a row this process creates. One of
 * `PLACEHOLDER_OWNER_IDS` in app/lib/boardAccess.ts, which is what makes such a
 * row claimable: the first real device to write to it takes ownership.
 */
const SERVER_OWNER = "server";

/**
 * What became of a durable scene write. The room is told all of these except
 * `skipped`, which is not a failure — a deployment with no `DATABASE_URL`, or a
 * room whose id could never be a board, has no store of record to lose the work
 * from, and warning about a choice the operator made would be noise.
 */
const SCENE_WRITE = Object.freeze({
  SAVED: "saved",
  /** The board was deleted from the gallery; the scene is deliberately dropped. */
  DELETED: "deleted",
  /** Over MAX_SCENE_BYTES — nothing will store this scene until it shrinks. */
  TOO_LARGE: "too-large",
  /** Postgres refused or could not be reached; may well work next time. */
  UNREACHABLE: "unreachable",
  SKIPPED: "skipped",
});

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
 * Write a room's merged scene to its board row, creating the row when it is not
 * there and reporting what happened.
 *
 * This was a bare UPDATE, on two arguments. First, that the app always creates
 * the row while rendering `/board/<id>` before any socket can connect, so a
 * missing row could only mean Postgres was unreachable — but the app skips
 * `ensureBoard` for a visitor who blocks cookies (there being no honest owner to
 * stamp), and a database that was down during that render is usually up again by
 * the time this runs. Second, that inserting here would need a placeholder owner
 * and so produce a board nobody could rename or delete — which
 * `app/lib/boardAccess.ts` has since fixed by treating `"server"` as *unclaimed*,
 * naming this write as the reason it exists.
 *
 * What the UPDATE did when it matched nothing was log "scene kept in Redis only"
 * and return, leaving the room's work in a 24-hour cache and then nowhere, with
 * nothing said to the people drawing in it.
 *
 * The upsert cannot resurrect a deleted board: `do update` carries
 * `where boards.deleted_at is null`, so a board deleted from the gallery stays
 * deleted — and `rowCount === 0` now means precisely that, which is what makes
 * it worth telling the room instead of a log file.
 *
 * @returns {Promise<typeof SCENE_WRITE[keyof typeof SCENE_WRITE]>}
 */
async function saveBoardScene(boardId, shapes) {
  const db = getPool();
  if (!db) return SCENE_WRITE.SKIPPED;
  if (!isValidBoardId(boardId)) {
    // Only reachable from a client that did not come through `/board/<id>`,
    // since room ids are merely length-bounded. Such a room has no board and
    // never had one, so there is nothing to warn anybody about.
    console.warn(
      `saveBoardScene: ${boardId} is not a board id; no row created`,
    );
    return SCENE_WRITE.SKIPPED;
  }

  const scene = Array.isArray(shapes) ? shapes : [];
  const serialized = JSON.stringify(scene);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCENE_BYTES) {
    console.error(
      `saveBoardScene skipped: scene for ${boardId} exceeds ${MAX_SCENE_BYTES} bytes`,
    );
    return SCENE_WRITE.TOO_LARGE;
  }

  try {
    const result = await db.query(
      `insert into boards (id, owner_device_id, scene, element_count)
       values ($1, $2, $3::jsonb, $4)
       on conflict (id) do update
          set scene = excluded.scene,
              element_count = excluded.element_count,
              updated_at = now()
        where boards.deleted_at is null`,
      [boardId, SERVER_OWNER, serialized, scene.length],
    );
    if (result.rowCount === 0) {
      console.warn(
        `saveBoardScene: board ${boardId} is deleted; scene not written`,
      );
      return SCENE_WRITE.DELETED;
    }
    return SCENE_WRITE.SAVED;
  } catch (error) {
    console.error("saveBoardScene failed:", error.message);
    return SCENE_WRITE.UNREACHABLE;
  }
}

async function closePool() {
  if (!pool) return;
  await pool.end().catch(() => {});
  pool = null;
}

module.exports = {
  SCENE_WRITE,
  getPool,
  loadBoardScene,
  saveBoardScene,
  closePool,
};
