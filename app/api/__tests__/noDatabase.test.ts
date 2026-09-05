/**
 * Every board route with no `DATABASE_URL` — the deployment that has no cloud
 * tier at all.
 *
 * This is the configuration the project ships in: drawing, localStorage and live
 * collaboration work, and only saving is absent. It has its own file because
 * `isDatabaseConfigured` is read when `app/lib/db` is first imported, so "not
 * configured" cannot be arranged after the fact — and it is worth a file of its
 * own because the failure it prevents is not an error page but a connection
 * attempt: without the guard, `pg` dials localhost:5432 on every request and
 * fails as a bare `AggregateError` that reads like a crash rather than an
 * unconfigured feature.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Arranged before the imports below, because `app/lib/db` decides both of these
 * the moment it loads: whether a store is configured, and whether to say so.
 */
const notice = vi.hoisted(() => {
  // Deliberately absent — and deleted rather than assumed absent, since a Vitest
  // worker is shared with the suites that set it.
  delete process.env.DATABASE_URL;
  // Same reason: the "said it once" flag lives on `globalThis`, which outlives
  // this file's module registry.
  delete (globalThis as { __cdNoticeLogged?: boolean }).__cdNoticeLogged;

  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  return { warnings, restore: () => (console.warn = original) };
});

vi.mock("pg", () => import("../../lib/__tests__/helpers/fakePg"));
vi.mock("next/headers", () => import("../../lib/__tests__/helpers/fakeCookies"));

import * as pg from "../../lib/__tests__/helpers/fakePg";
import {
  DATABASE_DISABLED_MESSAGE,
  DatabaseNotConfiguredError,
  isDatabaseConfigured,
  query,
} from "../../lib/db";
import { POST as createBoard } from "../boards/route";
import { DELETE, PATCH } from "../boards/[id]/route";
import { POST as recordOpen } from "../boards/[id]/open/route";
import { PUT as saveScene } from "../boards/[id]/scene/route";
import { GET as readThumbnail, PUT as saveThumbnail } from "../boards/[id]/thumbnail/route";

const context = { params: Promise.resolve({ id: "b1" }) };

const request = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/boards/b1", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Each write route, with a body that would otherwise be perfectly valid. */
const writes: [string, () => Promise<Response>][] = [
  ["POST /api/boards", () => createBoard(request("POST", { title: "New" }))],
  [
    "PATCH /api/boards/:id",
    () => PATCH(request("PATCH", { title: "Renamed" }), context),
  ],
  ["DELETE /api/boards/:id", () => DELETE(request("DELETE"), context)],
  ["POST /api/boards/:id/open", () => recordOpen(request("POST"), context)],
  [
    "PUT /api/boards/:id/scene",
    () => saveScene(request("PUT", { scene: [] }), context),
  ],
  [
    "PUT /api/boards/:id/thumbnail",
    () =>
      saveThumbnail(
        request("PUT", { dataUrl: "data:image/jpeg;base64,/9j/4AAQ" }),
        context,
      ),
  ],
];

beforeEach(() => {
  pg.reset();
});

afterAll(() => {
  notice.restore();
});

describe("with no board store configured", () => {
  it("says so once, on the server, as the board layer is first loaded", async () => {
    // The one line that explains an app with no "My boards": logged at import so
    // it appears once per process rather than once per degraded request.
    expect(notice.warnings).toEqual([
      [
        "No DATABASE_URL: board saving is disabled. Drawing, local storage and live collaboration are unaffected.",
      ],
    ]);
  });

  it.each(writes)("%s explains why it cannot save", async (_name, send) => {
    const response = await send();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: DATABASE_DISABLED_MESSAGE });
  });

  it.each(writes)("%s never opens a connection", async (_name, send) => {
    // The whole point of the flag: no pool, no socket, no localhost:5432.
    await send();

    expect(pg.poolsCreated).toBe(0);
    expect(pg.queries).toEqual([]);
  });

  it("tells the visitor their canvas is still theirs", async () => {
    // The message reaches a toast in the editor, so it has to say what still
    // works — the board is in this browser — rather than just "unavailable".
    expect(DATABASE_DISABLED_MESSAGE).toContain("kept in this browser");
    expect(DATABASE_DISABLED_MESSAGE).toContain("Save to file");
  });

  it("still answers the gallery's thumbnail request", async () => {
    // The one route that does not degrade to an error: the card asks for a
    // picture, and "no picture" is a state it already draws.
    const response = await readThumbnail(request("GET"), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dataUrl: null });
    expect(pg.poolsCreated).toBe(0);
  });
});

describe("the query layer underneath", () => {
  it("knows it is not configured", () => {
    expect(isDatabaseConfigured).toBe(false);
  });

  it("refuses by name rather than dialling localhost", async () => {
    // What `pg` does with no connection string is worse than an error: it tries
    // 127.0.0.1:5432 and ::1:5432, fails once per address family, and surfaces a
    // bare `AggregateError` that a Server Component replays into the browser as a
    // render error — an unconfigured feature that looks like a crash.
    await expect(query("select 1")).rejects.toThrow(DatabaseNotConfiguredError);
    await expect(query("select 1")).rejects.toThrow(/DATABASE_URL is not set/);
    expect(pg.poolsCreated).toBe(0);
  });
});
