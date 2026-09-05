/**
 * The durable scene write, which is the only thing standing between a room's
 * drawing and a 24-hour Redis TTL.
 *
 * `pg` is faked by replacing `Pool` on the real module object *before* db.js
 * destructures it at load time — `vi.mock` rewrites `import` statements and this
 * module under test uses `require`, so a mock would silently not be used at all
 * (see roomState.test.js for the same trap).
 */
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodeRequire = createRequire(import.meta.url);
const pg = nodeRequire("pg");
const realPool = pg.Pool;
const realUrl = process.env.DATABASE_URL;

/** Local, so `sslFor` asks for no TLS a fake pool would not provide anyway. */
const LOCAL_URL = "postgres://u:p@localhost:5432/collabdraw";

/** The last SQL and parameters the module sent, whatever it did with them. */
let sent;

/**
 * @param {object} [options]
 * @param {(sql: string, params: unknown[]) => unknown} [options.query] what the
 *   database answers; the default is one affected row.
 * @param {string | null} [options.url] DATABASE_URL for this load; `null` for a
 *   deployment that has none. Not `undefined` — that is what the parameter
 *   default is written in, so passing it asks for the default.
 */
const load = ({ query, url = LOCAL_URL } = {}) => {
  sent = [];
  pg.Pool = class FakePool {
    on() {}
    async query(sql, params) {
      sent.push({ sql, params });
      return query ? query(sql, params) : { rowCount: 1 };
    }
    async end() {}
  };

  if (url === null) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = url;
  }

  delete nodeRequire.cache[nodeRequire.resolve("../db.js")];
  return nodeRequire("../db.js");
};

const shapes = [{ id: "s1", tool: "Square" }];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  pg.Pool = realPool;
  // Env, not just the module: a worker process is shared between test files.
  if (realUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = realUrl;
  }
  delete nodeRequire.cache[nodeRequire.resolve("../db.js")];
  vi.restoreAllMocks();
});

describe("saveBoardScene", () => {
  it("creates the row when there is none, with a claimable owner", async () => {
    // The case the old UPDATE dropped on the floor: no row, so no write, so the
    // work lived in Redis until the TTL took it.
    const { SCENE_WRITE, saveBoardScene } = load();

    expect(await saveBoardScene("board1", shapes)).toBe(SCENE_WRITE.SAVED);
    expect(sent).toHaveLength(1);
    expect(sent[0].sql).toContain("insert into boards");
    expect(sent[0].sql).toContain("on conflict (id) do update");
    // "server" is one of app/lib/boardAccess.ts's PLACEHOLDER_OWNER_IDS, so the
    // first real device to touch this board takes it over.
    expect(sent[0].params[1]).toBe("server");
  });

  it("cannot resurrect a board that was deleted", async () => {
    const { saveBoardScene } = load();
    await saveBoardScene("board1", shapes);

    // The guard is on the update half, not the insert: a deleted row still
    // conflicts, and this is what stops the conflict from reviving it.
    expect(sent[0].sql).toContain("where boards.deleted_at is null");
  });

  it("writes the scene and its element count", async () => {
    const { saveBoardScene } = load();
    await saveBoardScene("board1", shapes);

    expect(sent[0].params[0]).toBe("board1");
    expect(JSON.parse(sent[0].params[2])).toEqual(shapes);
    expect(sent[0].params[3]).toBe(1);
  });

  it("reports a deleted board when the upsert changes nothing", async () => {
    // Now that the row is created when missing, no affected rows means one thing
    // only — which is what makes it worth telling the room about.
    const { SCENE_WRITE, saveBoardScene } = load({
      query: () => ({ rowCount: 0 }),
    });

    expect(await saveBoardScene("board1", shapes)).toBe(SCENE_WRITE.DELETED);
  });

  it("reports an unreachable store when the query throws", async () => {
    const { SCENE_WRITE, saveBoardScene } = load({
      query: () => {
        throw new Error("connection terminated");
      },
    });

    expect(await saveBoardScene("board1", shapes)).toBe(
      SCENE_WRITE.UNREACHABLE,
    );
  });

  it("refuses a scene too large for the column, without asking", async () => {
    const { SCENE_WRITE, saveBoardScene } = load();
    const huge = [{ id: "s1", note: "x".repeat(3 * 1024 * 1024) }];

    expect(await saveBoardScene("board1", huge)).toBe(SCENE_WRITE.TOO_LARGE);
    expect(sent).toHaveLength(0);
  });

  it("creates nothing for an id the app could never open", async () => {
    // Room ids are only length-bounded, so anything can arrive here. Harmless
    // while this was an UPDATE that matched nothing; a row nobody can reach once
    // it can insert.
    const { SCENE_WRITE, saveBoardScene } = load();

    expect(await saveBoardScene("../../etc/passwd", shapes)).toBe(
      SCENE_WRITE.SKIPPED,
    );
    expect(sent).toHaveLength(0);
  });

  it("skips quietly when there is no database configured", async () => {
    // The project's current state, and a deliberate one: no store of record to
    // lose anything from, so nothing to warn a room about.
    const { SCENE_WRITE, saveBoardScene } = load({ url: null });

    expect(await saveBoardScene("board1", shapes)).toBe(SCENE_WRITE.SKIPPED);
    expect(sent).toHaveLength(0);
  });
});

describe("loadBoardScene", () => {
  it("reads a stored scene", async () => {
    const { loadBoardScene } = load({
      query: () => ({ rows: [{ scene: shapes }] }),
    });

    expect(await loadBoardScene("board1")).toEqual(shapes);
    expect(sent[0].sql).toContain("deleted_at is null");
  });

  it("answers null for a board that is not there", async () => {
    const { loadBoardScene } = load({ query: () => ({ rows: [] }) });

    expect(await loadBoardScene("board1")).toBeNull();
  });

  it("answers null rather than throwing when the store is unreachable", async () => {
    const { loadBoardScene } = load({
      query: () => {
        throw new Error("connection terminated");
      },
    });

    expect(await loadBoardScene("board1")).toBeNull();
  });
});
