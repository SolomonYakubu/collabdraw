/**
 * GET and PUT /api/boards/:id/thumbnail — the gallery's picture of a board.
 *
 * The PUT is the only route that stores a string the app later renders, so it is
 * where the media type and the size ceiling are enforced. The GET is the opposite
 * kind of route: it must never fail, because a broken preview would replace a
 * whole card in the gallery with an error state, so a missing row, a bad id and an
 * unreachable database all come back as `{ dataUrl: null }` — the shape the card
 * already knows how to draw as "not previewed yet".
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
import { GET, PUT } from "../boards/[id]/thumbnail/route";

const context = (id = "b1") => ({ params: Promise.resolve({ id }) });

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

const get = () =>
  new NextRequest("http://localhost/api/boards/b1/thumbnail", { method: "GET" });

const put = (body: unknown) =>
  new NextRequest("http://localhost/api/boards/b1/thumbnail", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The upsert itself — the last query the route makes. */
const write = () => pg.queries[pg.queries.length - 1];

beforeEach(() => {
  pg.reset();
  cookies.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reading a thumbnail", () => {
  it("answers with the stored image", async () => {
    pg.answerWith([{ data_url: JPEG }]);

    const response = await GET(get(), context("V1StGXR8_Z"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dataUrl: JPEG });
    expect(pg.flatten(pg.queries[0].text)).toBe(
      "select data_url from board_thumbnails where board_id = $1",
    );
    expect(pg.queries[0].params).toEqual(["V1StGXR8_Z"]);
  });

  it("answers with no image for a board that has never been previewed", async () => {
    const response = await GET(get(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dataUrl: null });
  });

  it("keeps the same shape when the store cannot be reached", async () => {
    // A 500 here would turn one unreachable query into a gallery of broken cards;
    // the card's own "not previewed yet" state is the better answer.
    pg.failWith(new Error("connection terminated unexpectedly"));

    const response = await GET(get(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dataUrl: null });
    expect(console.error).toHaveBeenCalledWith(
      "GET thumbnail failed:",
      expect.any(Error),
    );
  });

  it("does not query for an id that could not have come from us", async () => {
    const response = await GET(get(), context("../secrets"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ dataUrl: null });
    expect(pg.queries).toEqual([]);
  });
});

describe("storing a thumbnail", () => {
  it("upserts it, so a board keeps one row however often it is redrawn", async () => {
    // Capture is debounced on every edit, so this route is hit repeatedly for the
    // same board; an insert without the conflict clause would grow forever.
    const response = await PUT(put({ dataUrl: JPEG }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(pg.flatten(write().text)).toBe(
      "insert into board_thumbnails (board_id, data_url) values ($1, $2) on conflict (board_id) do update set data_url = $2, updated_at = now()",
    );
    expect(write().params).toEqual(["b1", JPEG]);
  });

  it("creates the board on demand for a device that has a cookie", async () => {
    // The thumbnail has a foreign key on the board; a first capture on a board
    // reached by share link would otherwise fail on a row that does not exist.
    await PUT(put({ dataUrl: JPEG }), context());

    expect(pg.flatten(pg.queries[0].text)).toContain("insert into boards");
    expect(pg.queries[0].params).toEqual(["b1", "device-a", null]);
  });

  it("stores the image without inventing an owner when there is no cookie", async () => {
    cookies.setDeviceId("");

    await PUT(put({ dataUrl: JPEG }), context());

    expect(pg.sql()).toHaveLength(1);
    expect(pg.flatten(write().text)).toContain("insert into board_thumbnails");
  });
});

describe("a thumbnail it will not store", () => {
  it("takes only an image data URL", async () => {
    // What is checked is the `data:image/` prefix, and that is all: the value is
    // rendered by the gallery in an `<img src>`, where a data URL cannot reach the
    // page around it. Anything that is not one — a remote URL, a script scheme, a
    // missing or non-string field — is refused outright.
    for (const dataUrl of [
      undefined,
      null,
      42,
      "",
      "https://evil.example.com/tracker.gif",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      " data:image/jpeg;base64,AA",
    ]) {
      pg.reset();

      const response = await PUT(put({ dataUrl }), context());

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid image." });
      expect(pg.queries).toEqual([]);
    }
  });

  it("refuses an image too large for the column", async () => {
    // A 480px jpeg is 20-40 KB; anything near the 200 KiB ceiling is not one, and
    // the debounce means this route would be hit with it again and again.
    const response = await PUT(
      put({ dataUrl: `data:image/jpeg;base64,${"A".repeat(201 * 1024)}` }),
      context(),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Thumbnail too large." });
    expect(pg.queries).toEqual([]);
  });

  it("refuses an id that could not have come from us", async () => {
    const response = await PUT(put({ dataUrl: JPEG }), context("a".repeat(65)));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid board id." });
    expect(pg.queries).toEqual([]);
  });

  it("says it could not save, without repeating the driver's words", async () => {
    pg.failWith(new Error('relation "board_thumbnails" does not exist'));

    const response = await PUT(put({ dataUrl: JPEG }), context());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not save thumbnail." });
    expect(console.error).toHaveBeenCalledWith(
      "PUT thumbnail failed:",
      expect.any(Error),
    );
  });
});
