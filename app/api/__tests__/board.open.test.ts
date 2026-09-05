/**
 * POST /api/boards/:id/open — the request that puts a board somebody shared with
 * you into your own recents.
 *
 * It is a write on a path any visitor can reach, and it writes two rows: the
 * board itself when the link is being followed for the first time, and the open
 * record keyed by `(device_id, board_id)`. The pair is what these tests pin —
 * both statements, in order, with the arguments the right way round, since the id
 * and the device id are both opaque strings and swapping them fails silently.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://u:p@db.example.com/app?sslmode=require";
});

vi.mock("pg", () => import("../../lib/__tests__/helpers/fakePg"));
vi.mock("next/headers", () => import("../../lib/__tests__/helpers/fakeCookies"));

import * as cookies from "../../lib/__tests__/helpers/fakeCookies";
import * as pg from "../../lib/__tests__/helpers/fakePg";
import { POST } from "../boards/[id]/open/route";

const context = (id = "b1") => ({ params: Promise.resolve({ id }) });

const open = () =>
  new NextRequest("http://localhost/api/boards/b1/open", { method: "POST" });

beforeEach(() => {
  pg.reset();
  cookies.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recording that a device opened a board", () => {
  it("creates the board when the link is being followed for the first time", async () => {
    // A share link can arrive before any row exists — the board may only ever
    // have lived in the other person's browser. 404 here would be a dead link.
    const response = await POST(open(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(pg.flatten(pg.queries[0].text)).toBe(
      "insert into boards (id, owner_device_id, title) values ($1, $2, coalesce($3, 'Untitled board')) on conflict (id) do nothing",
    );
    expect(pg.queries[0].params).toEqual(["b1", "device-a", null]);
  });

  it("upserts the open record for this device and board", async () => {
    // `recordBoardOpen(boardId, deviceId)` binds them the other way round, and a
    // pair of ids swapped here is a recents list that quietly stays empty.
    await POST(open(), context("V1StGXR8_Z"));

    expect(pg.queries[1].params).toEqual(["device-a", "V1StGXR8_Z"]);
    expect(pg.flatten(pg.queries[1].text)).toContain(
      "on conflict (device_id, board_id) do update set last_opened_at = now()",
    );
  });

  it("touches the board so the gallery can sort by recency", async () => {
    await POST(open(), context());

    expect(pg.flatten(pg.queries[2].text)).toBe(
      "update boards set last_opened_at = now() where id = $1",
    );
    expect(pg.queries[2].params).toEqual(["b1"]);
  });
});

describe("an open it will not record", () => {
  it("refuses an id that could not have come from us", async () => {
    for (const id of ["", "a".repeat(65), "../secrets"]) {
      pg.reset();

      const response = await POST(open(), context(id));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false });
      expect(pg.queries).toEqual([]);
    }
  });

  it("refuses a caller with no device cookie", async () => {
    // There is nobody to record the open against, and `ensureBoard` would stamp
    // the board with an owner no device can ever match.
    cookies.setDeviceId("");

    const response = await POST(open(), context());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false });
    expect(pg.queries).toEqual([]);
  });

  it("says it could not record the open when the store is unreachable", async () => {
    pg.failWith(new Error("timeout expired"));

    const response = await POST(open(), context());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not record open." });
    expect(console.error).toHaveBeenCalledWith(
      "POST open failed:",
      expect.any(Error),
    );
  });
});
