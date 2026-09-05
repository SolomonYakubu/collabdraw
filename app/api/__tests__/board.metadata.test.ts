/**
 * PATCH and DELETE /api/boards/:id — rename and remove, the two requests that
 * change a board without touching its drawing.
 *
 * They are the only place ownership is enforced: the board id is in the URL of a
 * link anyone can hold, so what stops a visitor from renaming somebody else's
 * board is `mayWriteBoardMetadata` and nothing else. Every test here is about
 * which caller gets through — and about the claim-on-write rule, which hands an
 * ownerless row (a board the socket server flushed) to the first real device
 * that writes to it, instead of leaving it unrenameable forever.
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
import { DELETE, PATCH } from "../boards/[id]/route";

/** Route context: the id Next would have parsed out of the path. */
const context = (id = "b1") => ({ params: Promise.resolve({ id }) });

const patch = (body: unknown) =>
  new NextRequest("http://localhost/api/boards/b1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const del = () =>
  new NextRequest("http://localhost/api/boards/b1", { method: "DELETE" });

/** The board `getBoard` will find, or nothing at all. */
const boardOwnedBy = (owner: string | null) =>
  pg.answerWith([{ id: "b1", owner_device_id: owner }]);
const noBoard = () => pg.answerWith([]);

beforeEach(() => {
  pg.reset();
  cookies.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renaming a board", () => {
  it("writes the new title for the owner device", async () => {
    boardOwnedBy("device-a");

    const response = await PATCH(patch({ title: "Q3 roadmap" }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(pg.flatten(pg.queries[1].text)).toBe(
      "update boards set title = $2, updated_at = now() where id = $1",
    );
    expect(pg.queries[1].params).toEqual(["b1", "Q3 roadmap"]);
  });

  it("trims the title and keeps it inside the column", async () => {
    boardOwnedBy("device-a");

    await PATCH(patch({ title: `  ${"T".repeat(500)}  ` }), context());

    expect(pg.queries[1].params[1]).toBe("T".repeat(200));
  });

  it("asks for a title before it asks the database anything", async () => {
    // A rename with nothing to rename to would blank the card in the gallery.
    for (const body of [{}, { title: "   " }, { title: 42 }, { title: null }]) {
      pg.reset();

      const response = await PATCH(patch(body), context());

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Title required." });
      expect(pg.queries).toEqual([]);
    }
  });

  it("refuses an id that could not have come from us", async () => {
    // The id is a path segment and goes on to be a primary key, so its shape is
    // checked before the query rather than trusted from the URL.
    for (const id of ["", "a".repeat(65), "../secrets", "b 1", "b'1"]) {
      pg.reset();

      const response = await PATCH(patch({ title: "x" }), context(id));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid board id." });
      expect(pg.queries).toEqual([]);
    }
  });

  it("answers not found for a board that is gone", async () => {
    noBoard();

    const response = await PATCH(patch({ title: "x" }), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
    expect(pg.sql()).toHaveLength(1);
  });

  it("refuses a device that does not own the board", async () => {
    // The whole point of the route: holding the link lets you draw, not rename.
    boardOwnedBy("device-z");

    const response = await PATCH(patch({ title: "mine now" }), context());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden." });
    expect(pg.sql()).toHaveLength(1);
  });

  it("refuses a caller with no device id, even on an unclaimed board", async () => {
    // Otherwise the cookieless caller and the placeholder owner would match, and
    // any visitor could rename every board the socket server ever flushed.
    cookies.setDeviceId("");
    boardOwnedBy("server");

    const response = await PATCH(patch({ title: "mine now" }), context());

    expect(response.status).toBe(403);
    expect(pg.sql()).toHaveLength(1);
  });

  it("takes ownership of an unclaimed board on the way through", async () => {
    // Rows written by something with no cookie to stamp: the socket server's
    // flush, or a request that arrived before middleware issued one.
    for (const owner of [null, "", "server", "anonymous"]) {
      pg.reset();
      boardOwnedBy(owner);

      const response = await PATCH(patch({ title: "Now mine" }), context());

      expect(response.status).toBe(200);
      const claim = pg.queries[1];
      expect(pg.flatten(claim.text)).toContain("set owner_device_id = $2");
      expect(claim.params[0]).toBe("b1");
      expect(claim.params[1]).toBe("device-a");
      // The guard that makes the claim safe against a second caller racing it.
      expect(pg.flatten(claim.text)).toContain(
        "where id = $1 and (owner_device_id is null or owner_device_id = any($3))",
      );
      expect(claim.params[2]).toEqual(["", "server", "anonymous"]);
      expect(pg.flatten(pg.queries[2].text)).toContain("set title = $2");
    }
  });

  it("does not re-claim a board it already owns", async () => {
    boardOwnedBy("device-a");

    await PATCH(patch({ title: "Same owner" }), context());

    expect(pg.sql()).toHaveLength(2);
  });

  it("says it could not update, without repeating the driver's words", async () => {
    pg.failWith(new Error("relation \"boards\" does not exist"));

    const response = await PATCH(patch({ title: "x" }), context());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not update board." });
    expect(console.error).toHaveBeenCalledWith(
      "PATCH /api/boards/:id failed:",
      expect.any(Error),
    );
  });
});

describe("deleting a board", () => {
  it("soft-deletes it for the owner device", async () => {
    // A row, not a removal: the socket server may still be holding the room, and
    // every read filters on `deleted_at is null`.
    boardOwnedBy("device-a");

    const response = await DELETE(del(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(pg.flatten(pg.queries[1].text)).toBe(
      "update boards set deleted_at = now() where id = $1",
    );
    expect(pg.queries[1].params).toEqual(["b1"]);
  });

  it("reports success for a board that is already gone", async () => {
    // Deleting something that no longer exists leaves the caller in the state it
    // asked for; a 404 here only makes the gallery show an error it cannot act on.
    noBoard();

    const response = await DELETE(del(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(pg.sql()).toHaveLength(1);
  });

  it("refuses a device that does not own the board", async () => {
    boardOwnedBy("device-z");

    const response = await DELETE(del(), context());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden." });
    expect(pg.sql()).toHaveLength(1);
  });

  it("refuses an id that could not have come from us", async () => {
    const response = await DELETE(del(), context("a".repeat(65)));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid board id." });
    expect(pg.queries).toEqual([]);
  });

  it("claims an unclaimed board before removing it", async () => {
    boardOwnedBy("server");

    await DELETE(del(), context());

    expect(pg.flatten(pg.queries[1].text)).toContain("set owner_device_id = $2");
    expect(pg.flatten(pg.queries[2].text)).toContain("set deleted_at = now()");
  });

  it("says it could not delete, without repeating the driver's words", async () => {
    pg.failWith(new Error("connection terminated unexpectedly"));

    const response = await DELETE(del(), context());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not delete board." });
    expect(console.error).toHaveBeenCalledWith(
      "DELETE /api/boards/:id failed:",
      expect.any(Error),
    );
  });
});
