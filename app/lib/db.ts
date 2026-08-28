import { Pool, type QueryResultRow } from "pg";

import { PLACEHOLDER_OWNER_IDS } from "./boardAccess";
import type { Shape, Viewport } from "../types/shapes";

/**
 * Postgres access for the Next.js runtime.
 *
 * Every entry point here needs `DATABASE_URL`. When it is missing the app is
 * expected to keep working without a cloud tier, so the failure is a single
 * explicit `DatabaseNotConfiguredError` rather than a connection attempt.
 */
const globalForDb = globalThis as unknown as {
  __cdPool?: Pool;
  __cdNoticeLogged?: boolean;
};

/** True once a connection string is configured; false means "no cloud tier". */
export const isDatabaseConfigured = Boolean(process.env.DATABASE_URL);

/** What every caller shows when there is no board store to talk to. */
export const DATABASE_DISABLED_MESSAGE =
  "Saving to your boards is not configured on this deployment. Your canvas is kept in this browser; use “Save to file” to keep a copy.";

/**
 * Thrown instead of attempting a connection when `DATABASE_URL` is absent.
 *
 * Without this, `pg` falls back to its own defaults and dials localhost:5432 on
 * every request. That fails once per address family and surfaces as a bare
 * `AggregateError` with no message — which in a Server Component is replayed
 * into the browser console as a render error, so a deployment that simply has
 * no cloud tier looks like a crash.
 */
export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_URL is not set — the cloud board store is disabled.");
    this.name = "DatabaseNotConfiguredError";
  }
}

/*
 * Say so once, on the server, the first time anything in the app touches the
 * board layer without a connection string. Callers degrade on their own; this
 * is the line that explains why boards are missing.
 */
if (!isDatabaseConfigured && !globalForDb.__cdNoticeLogged) {
  globalForDb.__cdNoticeLogged = true;
  console.warn(
    "No DATABASE_URL: board saving is disabled. Drawing, local storage and live collaboration are unaffected.",
  );
}

/**
 * Neon — and every other managed Postgres — requires TLS. A local
 * `postgres://localhost/collabdraw` usually has no certificate at all and
 * refuses the handshake, so decide from the connection string instead of making
 * anyone edit code to try one or the other.
 *
 * A remote connection is verified. `pg` already treats `sslmode=require` as
 * `verify-full`, and Neon presents a publicly valid certificate, so verifying
 * costs nothing — an unverified TLS connection to a database over the open
 * internet is a MITM waiting to happen. A host behind a private CA opts out
 * explicitly with `sslmode=no-verify`.
 */
export function sslForConnection(
  connectionString: string,
): false | { rejectUnauthorized: boolean } {
  if (/sslmode=disable/i.test(connectionString)) {
    return false;
  }
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(
    connectionString,
  );
  if (isLocal) {
    return false;
  }
  return { rejectUnauthorized: !/sslmode=no-verify/i.test(connectionString) };
}

/**
 * The pool, created on first use. A single instance is cached on `globalThis`
 * so Next.js dev hot-reloads (which re-evaluate modules) don't leak a new pool
 * on every reload. Uses the pooled (`-pooler`) connection string; keep `max`
 * small because serverless functions multiply connection count.
 */
function getPool(): Pool {
  if (!isDatabaseConfigured) {
    throw new DatabaseNotConfiguredError();
  }

  const existing = globalForDb.__cdPool;
  if (existing) {
    return existing;
  }

  const connectionString = process.env.DATABASE_URL as string;
  const pool = new Pool({
    connectionString,
    ssl: sslForConnection(connectionString),
    max: 3,
    idleTimeoutMillis: 10_000,
  });

  /*
   * `pg` emits 'error' on *idle* clients — a Neon connection dropped between
   * queries, a network blip. That event has no `await` waiting on it, so
   * without a listener Node treats it as unhandled and kills the process. The
   * pool discards the client itself; logging is all that is needed here.
   */
  pool.on("error", (error) => {
    console.error("Postgres pool error (idle client):", error);
  });

  globalForDb.__cdPool = pool;
  return pool;
}

export async function query<T extends QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as never[]);
  return result.rows;
}

export interface BoardRow {
  id: string;
  title: string;
  owner_device_id: string;
  owner_user_id: string | null;
  scene: Shape[];
  viewport: Viewport | null;
  element_count: number;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
  deleted_at: string | null;
}

/** Metadata-only shape for the dashboard list (no scene payload). */
export interface BoardSummary {
  id: string;
  title: string;
  owner_device_id: string;
  element_count: number;
  updated_at: string;
  last_opened_at: string;
}

const SUMMARY_COLUMNS =
  "id, title, owner_device_id, element_count, updated_at, last_opened_at";

/** Insert a board if it doesn't exist yet (create-on-demand for shared links). */
export async function ensureBoard(
  id: string,
  deviceId: string,
  title?: string,
): Promise<void> {
  await query(
    `insert into boards (id, owner_device_id, title)
     values ($1, $2, coalesce($3, 'Untitled board'))
     on conflict (id) do nothing`,
    [id, deviceId, title ?? null],
  );
}

/**
 * Create a board, optionally carrying the scene that is already on screen.
 * "Save to my boards" on the local canvas is exactly that: the drawing exists
 * before the board does, so inserting them together avoids a create-then-save
 * pair where a failed second call would leave an empty board behind.
 */
export async function createBoard(
  id: string,
  deviceId: string,
  title?: string,
  scene?: Shape[],
  viewport?: Viewport | null,
): Promise<void> {
  await query(
    `insert into boards (id, owner_device_id, title, scene, viewport, element_count)
     values ($1, $2, coalesce($3, 'Untitled board'), coalesce($4::jsonb, '[]'::jsonb), $5::jsonb, $6)`,
    [
      id,
      deviceId,
      title ?? null,
      scene ? JSON.stringify(scene) : null,
      viewport ? JSON.stringify(viewport) : null,
      scene?.length ?? 0,
    ],
  );
}

export async function getBoard(id: string): Promise<BoardRow | null> {
  const rows = await query<BoardRow>(
    `select * from boards where id = $1 and deleted_at is null`,
    [id],
  );
  return rows[0] ?? null;
}

/** Boards owned by a device plus boards that device has opened, newest first. */
export async function listBoardsForDevice(
  deviceId: string,
): Promise<BoardSummary[]> {
  return query<BoardSummary>(
    `select ${SUMMARY_COLUMNS}
       from boards b
      where b.deleted_at is null
        and (
          b.owner_device_id = $1
          or exists (
            select 1 from board_opens o
             where o.board_id = b.id and o.device_id = $1
          )
        )
      order by greatest(b.updated_at, b.last_opened_at) desc
      limit 200`,
    [deviceId],
  );
}

export async function updateBoardTitle(
  id: string,
  title: string,
): Promise<void> {
  await query(
    `update boards set title = $2, updated_at = now() where id = $1`,
    [id, title],
  );
}

/**
 * Take ownership of a board that no device owns (see PLACEHOLDER_OWNER_IDS).
 * The `where` clause is the guard: a board that already belongs to a device is
 * left alone, so two callers racing cannot steal it from each other.
 */
export async function claimBoard(
  id: string,
  deviceId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `update boards
        set owner_device_id = $2
      where id = $1
        and (owner_device_id is null or owner_device_id = any($3))
      returning id`,
    [id, deviceId, PLACEHOLDER_OWNER_IDS as readonly string[]],
  );
  return rows.length > 0;
}

export async function softDeleteBoard(id: string): Promise<void> {
  await query(`update boards set deleted_at = now() where id = $1`, [id]);
}

/** Offline / beacon scene write from the client (last-write-wins). */
export async function saveBoardScene(
  id: string,
  scene: Shape[],
  viewport: Viewport | null,
): Promise<void> {
  await query(
    `update boards
        set scene = $2::jsonb,
            viewport = $3::jsonb,
            element_count = $4,
            updated_at = now()
      where id = $1`,
    [id, JSON.stringify(scene), viewport ? JSON.stringify(viewport) : null, scene.length],
  );
}

export async function recordBoardOpen(
  boardId: string,
  deviceId: string,
): Promise<void> {
  await query(
    `insert into board_opens (device_id, board_id)
     values ($1, $2)
     on conflict (device_id, board_id) do update set last_opened_at = now()`,
    [deviceId, boardId],
  );
  await query(`update boards set last_opened_at = now() where id = $1`, [
    boardId,
  ]);
}

export async function getThumbnail(boardId: string): Promise<string | null> {
  const rows = await query<{ data_url: string }>(
    `select data_url from board_thumbnails where board_id = $1`,
    [boardId],
  );
  return rows[0]?.data_url ?? null;
}

export async function saveThumbnail(
  boardId: string,
  dataUrl: string,
): Promise<void> {
  await query(
    `insert into board_thumbnails (board_id, data_url)
     values ($1, $2)
     on conflict (board_id) do update set data_url = $2, updated_at = now()`,
    [boardId, dataUrl],
  );
}
