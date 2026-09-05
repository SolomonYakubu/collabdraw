/**
 * `app/lib/db.ts` — the pool, and the statements the app's reads are made of.
 *
 * The board routes already assert the writes they send through this layer; what
 * is left, and what this file is for, is the part no route can see. The pool is
 * cached on `globalThis` because a dev hot-reload re-evaluates the module and
 * would otherwise leak a pool per reload until Postgres refuses connections. It
 * carries a TLS decision made from a pasted-in string. And it needs a listener
 * for errors on *idle* clients, because that event has nothing awaiting it and
 * an unhandled one takes the process down — a dropped Neon connection between
 * two requests would end the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://u:p@db.example.com/app?sslmode=require";
});

vi.mock("pg", () => import("./helpers/fakePg"));

import * as pg from "./helpers/fakePg";
import {
  getBoard,
  listBoardsForDevice,
  query,
  recordBoardOpen,
} from "../db";

beforeEach(() => {
  pg.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the pool", () => {
  it("is built from DATABASE_URL, with TLS and a small ceiling", async () => {
    // `max` is deliberately low: a serverless deployment multiplies this by the
    // number of warm instances, and Neon's connection limit is not generous.
    await query("select 1");

    expect(pg.poolOptions).toEqual({
      connectionString: "postgres://u:p@db.example.com/app?sslmode=require",
      ssl: { rejectUnauthorized: true },
      max: 3,
      idleTimeoutMillis: 10_000,
    });
  });

  it("is created once and reused", async () => {
    // The hot-reload leak: each re-evaluation of the module would open another
    // pool, and dev sessions ended in "too many clients already".
    await query("select 1");
    await query("select 2");
    await getBoard("b1");

    expect(pg.poolsCreated).toBe(1);
    expect(pg.sql()).toHaveLength(3);
  });

  it("logs an error on an idle client instead of letting it end the process", async () => {
    await query("select 1");
    const onError = pg.poolListeners.get("error");
    expect(onError).toBeTypeOf("function");

    const dropped = new Error("Connection terminated unexpectedly");
    expect(() => onError?.(dropped)).not.toThrow();

    expect(console.error).toHaveBeenCalledWith(
      "Postgres pool error (idle client):",
      dropped,
    );
  });
});

describe("query", () => {
  it("hands back the rows and nothing else", async () => {
    pg.answerWith([{ id: "b1" }, { id: "b2" }]);

    expect(await query("select id from boards")).toEqual([
      { id: "b1" },
      { id: "b2" },
    ]);
  });

  it("sends parameters as parameters", async () => {
    // Every caller in this file relies on it: the ids and titles it binds are
    // request data, and the only reason they are safe is that they stay bound.
    await query("select * from boards where id = $1", ["b'1; drop table boards"]);

    expect(pg.queries[0].params).toEqual(["b'1; drop table boards"]);
  });

  it("answers with an empty list when a statement returns no rows", async () => {
    expect(await query("update boards set title = 'x'")).toEqual([]);
  });
});

describe("reading a board", () => {
  it("ignores one that has been deleted", async () => {
    // Soft delete is a column, so every read has to say so; the routes' 404s and
    // the gallery's contents both rest on this clause.
    await getBoard("b1");

    expect(pg.sql()[0]).toBe(
      "select * from boards where id = $1 and deleted_at is null",
    );
    expect(pg.queries[0].params).toEqual(["b1"]);
  });

  it("answers with nothing when there is no such board", async () => {
    expect(await getBoard("gone")).toBeNull();
  });

  it("answers with the row when there is", async () => {
    pg.answerWith([{ id: "b1", title: "Sprint plan" }]);

    expect(await getBoard("b1")).toEqual({ id: "b1", title: "Sprint plan" });
  });
});

describe("listing a device's boards", () => {
  it("includes boards it opened as well as boards it owns", async () => {
    // A board reached by someone else's share link belongs in your gallery, and
    // that is what makes the `board_opens` half of the clause necessary.
    await listBoardsForDevice("device-a");

    const text = pg.sql()[0];
    expect(text).toContain("b.owner_device_id = $1");
    expect(text).toContain(
      "exists ( select 1 from board_opens o where o.board_id = b.id and o.device_id = $1 )",
    );
    expect(pg.queries[0].params).toEqual(["device-a"]);
  });

  it("hides deleted boards, sorts by whichever timestamp is newer, and stops at 200", async () => {
    // Sorting on `updated_at` alone put a board you had just opened at the bottom
    // of your own gallery.
    await listBoardsForDevice("device-a");

    const text = pg.sql()[0];
    expect(text).toContain("b.deleted_at is null");
    expect(text).toContain(
      "order by greatest(b.updated_at, b.last_opened_at) desc",
    );
    expect(text).toContain("limit 200");
  });

  it("asks for no scene payload", async () => {
    // The gallery renders titles and counts; selecting `scene` would ship every
    // drawing the device has ever touched to build one page of cards.
    await listBoardsForDevice("device-a");

    expect(pg.sql()[0]).toContain(
      "select id, title, owner_device_id, element_count, updated_at, last_opened_at from boards b",
    );
    expect(pg.sql()[0]).not.toContain("scene");
  });
});

describe("recording an open", () => {
  it("touches the board as well as the open record", async () => {
    // Two statements, because the gallery sorts on the board's own timestamp.
    await recordBoardOpen("b1", "device-a");

    expect(pg.sql()).toEqual([
      "insert into board_opens (device_id, board_id) values ($1, $2) on conflict (device_id, board_id) do update set last_opened_at = now()",
      "update boards set last_opened_at = now() where id = $1",
    ]);
    expect(pg.queries[0].params).toEqual(["device-a", "b1"]);
    expect(pg.queries[1].params).toEqual(["b1"]);
  });
});
