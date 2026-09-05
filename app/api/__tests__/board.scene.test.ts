/**
 * PUT /api/boards/:id/scene — the last-resort scene write, sent by
 * `navigator.sendBeacon` on pagehide when no socket server is holding the room.
 *
 * It is the one save that has no second chance: the tab is closing, nothing reads
 * the response, and whatever this route decides is what the board contains when
 * it is next opened. So it validates the drawing itself rather than trusting the
 * beacon, measures the body before parsing it, and — because a beacon can arrive
 * from a shared link on a device with no cookie — writes the scene without
 * inventing an owner for it.
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
import { PUT } from "../boards/[id]/scene/route";

const context = (id = "b1") => ({ params: Promise.resolve({ id }) });

/** A shape as the editor writes it; `restoreElements` fills in the rest. */
const shape = (id: string) => ({
  id,
  tool: "Square",
  x: 10,
  y: 20,
  width: 30,
  height: 40,
});

/** A beacon: a raw body, since that is what `sendBeacon` posts. */
const beacon = (raw: string) =>
  new NextRequest("http://localhost/api/boards/b1/scene", {
    method: "PUT",
    body: raw,
  });

const save = (body: unknown) => beacon(JSON.stringify(body));

/** The scene write itself — the last query the route makes. */
const write = () => pg.queries[pg.queries.length - 1];

beforeEach(() => {
  pg.reset();
  cookies.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saving a scene", () => {
  it("writes the drawing, its size and the viewport in one statement", async () => {
    const response = await PUT(
      save({
        scene: [shape("a"), shape("b")],
        viewport: { zoom: 1.5, scroll: { x: 4, y: -8 } },
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(pg.flatten(write().text)).toBe(
      "update boards set scene = $2::jsonb, viewport = $3::jsonb, element_count = $4, updated_at = now() where id = $1",
    );
    expect(write().params[0]).toBe("b1");
    expect(JSON.parse(write().params[1] as string)).toHaveLength(2);
    expect(JSON.parse(write().params[2] as string)).toEqual({
      zoom: 1.5,
      scroll: { x: 4, y: -8 },
    });
    expect(write().params[3]).toBe(2);
  });

  it("puts every shape through the same validation the editor uses", async () => {
    // The beacon body is attacker-controlled and this row is loaded straight onto
    // the next person's canvas.
    await PUT(
      save({ scene: [shape("a"), { id: "b", tool: "NotATool" }, 7, null] }),
      context(),
    );

    expect(JSON.parse(write().params[1] as string)).toHaveLength(1);
    expect(write().params[3]).toBe(1);
  });

  it("saves an emptied canvas as empty", async () => {
    // Unlike board creation, an empty array here is a real edit: somebody
    // selected everything and deleted it, and closing the tab must keep that.
    await PUT(save({ scene: [] }), context());

    expect(write().params[1]).toBe("[]");
    expect(write().params[3]).toBe(0);
  });

  it("treats a body with no scene as an empty one", async () => {
    // `restoreElements` answers `[]` for anything that is not an array, so a
    // malformed-but-parseable beacon cannot write junk into the column.
    await PUT(save({ viewport: { zoom: 1, scroll: { x: 0, y: 0 } } }), context());

    expect(write().params[1]).toBe("[]");
  });

  it("stores no viewport rather than a broken one", async () => {
    for (const viewport of [
      { zoom: 2 },
      { zoom: "2", scroll: { x: 0, y: 0 } },
      { zoom: 1, scroll: { x: 0 } },
      { zoom: 1, scroll: null },
      // `1e999` parses to Infinity, which `JSON.stringify` writes as null — a
      // zoom no client can restore, and the reason both save paths now share one
      // reading of the viewport.
      JSON.parse('{"zoom":1e999,"scroll":{"x":0,"y":0}}'),
      "nope",
      null,
    ]) {
      pg.reset();

      await PUT(save({ scene: [shape("a")], viewport }), context());

      expect(write().params[2]).toBeNull();
    }
  });
});

describe("who the row ends up belonging to", () => {
  it("creates the board on demand for a device that has a cookie", async () => {
    // First save from a shared link: the row may not exist yet, and an update
    // alone would silently write nothing.
    await PUT(save({ scene: [shape("a")] }), context());

    expect(pg.flatten(pg.queries[0].text)).toContain("insert into boards");
    expect(pg.queries[0].params).toEqual(["b1", "device-a", null]);
    expect(pg.sql()).toHaveLength(2);
  });

  it("saves the scene without inventing an owner when there is no cookie", async () => {
    // A board stamped with a placeholder owner is one nobody can rename; better
    // to save the drawing and leave ownership to a caller that has an identity.
    // If the row does not exist yet, the update matches nothing — deliberately.
    cookies.setDeviceId("");

    const response = await PUT(save({ scene: [shape("a")] }), context());

    expect(response.status).toBe(200);
    expect(pg.sql()).toHaveLength(1);
    expect(pg.flatten(write().text)).toContain("update boards");
  });
});

describe("a scene it will not save", () => {
  it("refuses an id that could not have come from us", async () => {
    const response = await PUT(save({ scene: [] }), context("a".repeat(65)));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid board id." });
    expect(pg.queries).toEqual([]);
  });

  it("refuses a drawing too large for the column, before parsing it", async () => {
    // Measured on the raw text: a 3 MB beacon must not be hydrated into objects
    // first, or the ceiling costs more than it saves.
    const scene = Array.from({ length: 40_000 }, (_, i) => shape(`s${i}`));

    const response = await PUT(save({ scene }), context());

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Scene too large." });
    expect(pg.queries).toEqual([]);
  });

  it("refuses a body that is not JSON", async () => {
    const response = await PUT(beacon("<html>error page</html>"), context());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON." });
    expect(pg.queries).toEqual([]);
  });

  it("says it could not save, without repeating the driver's words", async () => {
    pg.failWith(new Error("could not connect to server: Connection refused"));

    const response = await PUT(save({ scene: [] }), context());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not save scene." });
    expect(console.error).toHaveBeenCalledWith(
      "PUT /api/boards/:id/scene failed:",
      expect.any(Error),
    );
  });
});
