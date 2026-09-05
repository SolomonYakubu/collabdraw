/**
 * POST /api/boards — "Save to my boards": the one request that promotes a canvas
 * living in localStorage to a row in Postgres.
 *
 * It is the only route that both creates a board and carries a whole drawing in
 * the same body, so it is where an untrusted scene first reaches the database.
 * The tests below run the real query layer against a faked `pg`, so what the
 * route decides and the statement it sends are asserted together.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // `isDatabaseConfigured` is computed when `app/lib/db` is first imported, so
  // the connection string has to be in place before the imports below run. The
  // no-database half of the contract has its own file, where it is absent.
  process.env.DATABASE_URL = "postgres://u:p@db.example.com/app?sslmode=require";
});

/** The limiter, kept out of the way: its own behaviour is tested elsewhere. */
const limiter = vi.hoisted(() => ({ allow: true, calls: [] as unknown[][] }));

vi.mock("pg", () => import("../../lib/__tests__/helpers/fakePg"));
vi.mock("next/headers", () => import("../../lib/__tests__/helpers/fakeCookies"));
vi.mock("../../lib/rateLimit", () => ({
  isAllowedRateLimit: async (...args: unknown[]) => {
    limiter.calls.push(args);
    return limiter.allow;
  },
}));

import * as cookies from "../../lib/__tests__/helpers/fakeCookies";
import * as pg from "../../lib/__tests__/helpers/fakePg";
import { POST } from "../boards/route";

/** A shape as the editor writes it; `restoreElements` fills in the rest. */
const shape = (id: string) => ({
  id,
  tool: "Square",
  x: 10,
  y: 20,
  width: 30,
  height: 40,
});

const request = (body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/boards", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The insert the route makes, and the values bound to it. */
const insert = () => pg.queries[0];

beforeEach(() => {
  pg.reset();
  cookies.reset();
  limiter.allow = true;
  limiter.calls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("creating a board", () => {
  it("answers with the id it minted, and inserts under that id", async () => {
    const response = await POST(request({ title: "Sprint plan" }));

    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(insert().params[0]).toBe(id);
  });

  it("stamps the caller's device as the owner", async () => {
    // The gallery is a server component and finds your boards by this column
    // alone; the wrong value here is a board you cannot see or rename.
    cookies.setDeviceId("device-b");

    await POST(request());

    expect(insert().params[1]).toBe("device-b");
  });

  it("leaves the title to the database when the body has none", async () => {
    await POST(request());

    expect(insert().params[2]).toBeNull();
    expect(pg.flatten(insert().text)).toContain(
      "coalesce($3, 'Untitled board')",
    );
  });

  it("keeps a title short enough for the column", async () => {
    await POST(request({ title: "T".repeat(500) }));

    expect(insert().params[2]).toBe("T".repeat(200));
  });

  it("ignores a title that is not a string", async () => {
    await POST(request({ title: { toString: "nice try" } }));

    expect(insert().params[2]).toBeNull();
  });
});

describe("the drawing it carries", () => {
  it("saves the scene from the body, with its element count", async () => {
    // `element_count` is what the gallery card shows, so it has to be the count
    // of what was actually stored rather than of what was sent.
    await POST(request({ scene: [shape("a"), shape("b")] }));

    const stored = JSON.parse(insert().params[3] as string);
    expect(stored.map((element: { id: string }) => element.id)).toEqual([
      "a",
      "b",
    ]);
    expect(insert().params[5]).toBe(2);
  });

  it("puts every shape through the same validation the editor uses", async () => {
    // The body is attacker-controlled, and this row is later loaded straight onto
    // somebody's canvas. Anything `restoreElements` will not vouch for is dropped.
    await POST(
      request({
        scene: [shape("a"), { id: "b", tool: "NotATool" }, "nope", null],
      }),
    );

    const stored = JSON.parse(insert().params[3] as string);
    expect(stored).toHaveLength(1);
    expect(insert().params[5]).toBe(1);
  });

  it("stores no scene at all when the body has none", async () => {
    // Not an empty array: `coalesce($4::jsonb, '[]')` is what fills it in, and an
    // absent scene must not be confused with a drawing somebody cleared.
    await POST(request({ title: "Empty" }));

    expect(insert().params[3]).toBeNull();
    expect(insert().params[5]).toBe(0);
  });

  it("keeps a well-formed viewport so the board reopens where it was", async () => {
    await POST(
      request({ scene: [shape("a")], viewport: { zoom: 2, scroll: { x: -5, y: 7 } } }),
    );

    expect(JSON.parse(insert().params[4] as string)).toEqual({
      zoom: 2,
      scroll: { x: -5, y: 7 },
    });
  });

  it("stores no viewport rather than a broken one", async () => {
    // A half-read viewport is worse than none: the board opens scrolled into
    // empty space with nothing on screen and no way to tell why.
    for (const viewport of [
      { zoom: 2 },
      { zoom: "2", scroll: { x: 0, y: 0 } },
      { zoom: Number.NaN, scroll: { x: 0, y: 0 } },
      { zoom: 1, scroll: { x: 0 } },
      { zoom: 1, scroll: null },
      "nope",
      null,
    ]) {
      pg.reset();

      await POST(request({ scene: [shape("a")], viewport }));

      expect(insert().params[4]).toBeNull();
    }
  });

  it("ignores a viewport sent without a scene", async () => {
    await POST(request({ viewport: { zoom: 2, scroll: { x: 1, y: 1 } } }));

    expect(insert().params[4]).toBeNull();
  });

  it("refuses a drawing too large for the column", async () => {
    // Measured before parsing, so an oversized body is rejected rather than
    // hydrated first — and the client is told why instead of getting a 500.
    const scene = Array.from({ length: 40_000 }, (_, i) => shape(`s${i}`));

    const response = await POST(request({ scene }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "That drawing is too large to save.",
    });
    expect(pg.queries).toEqual([]);
  });
});

describe("a request it will not save", () => {
  it("refuses a caller with no device cookie", async () => {
    // Nothing would own the board, and no gallery could ever list it.
    cookies.setDeviceId("");

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No device id." });
    expect(pg.queries).toEqual([]);
  });

  it("refuses once the caller is over the rate limit", async () => {
    limiter.allow = false;

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Too many requests." });
    expect(pg.queries).toEqual([]);
  });

  it("counts board creation per client address", async () => {
    await POST(request(undefined, { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }));

    expect(limiter.calls[0]).toEqual(["board-create:203.0.113.7", 30, 60]);
  });

  it("counts callers with no forwarded address together", async () => {
    await POST(request());

    expect(limiter.calls[0]).toEqual(["board-create:unknown", 30, 60]);
  });

  it("still creates an untitled board when the body is unusable", async () => {
    // "Save to my boards" with no body at all is the normal case from the menu;
    // a body that will not parse should behave the same rather than 400.
    const response = await POST(
      new NextRequest("http://localhost/api/boards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(201);
    expect(insert().params[2]).toBeNull();
  });

  it("says the store could not be reached, and does not leak the reason", async () => {
    // The message reaches a toast, and a driver error can name the host and the
    // database. The detail goes to the server log instead.
    pg.failWith(new Error("password authentication failed for user \"u\""));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Could not reach the board store. Nothing was saved.",
    });
    expect(console.error).toHaveBeenCalledWith(
      "POST /api/boards failed:",
      expect.any(Error),
    );
  });
});
