// @vitest-environment jsdom
/**
 * `/board/[id]` — the editor in a room, and the server render that fills it.
 *
 * The scene is fetched here rather than waited for over the socket because the
 * Redis snapshot has a TTL: once it lapses, the `scene` column is the only copy
 * of the board, and a room that trusted the socket alone would open blank on the
 * first visit of the day.
 *
 * The rest of the page is degradation, and each arm has a failure mode that is
 * silent rather than loud. A board id arrives from the URL and goes on to be a
 * primary key, so its shape is checked before the query layer sees it. A share
 * link can name a board that only ever lived in someone else's browser, so
 * opening an unknown id creates it instead of 404ing — but only when the visitor
 * has a device cookie to own it with, since a row stamped with a placeholder
 * owner can never be renamed or deleted afterwards. And Postgres is optional in
 * this app: unreachable, it has to leave a working canvas behind, because a
 * Server Component that throws replays the failure into the browser as a render
 * error and takes the editor down with it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://u:p@db.example.com/app?sslmode=require";
});

/** The editor is tested in its own file; here it is a set of props. */
const canvas = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

/**
 * `notFound()` is called for its throw — the page does not return it — so the
 * fake throws too. Without that, an invalid id would carry on into the query.
 */
const navigation = vi.hoisted(() => ({ notFound: vi.fn() }));

vi.mock("pg", () => import("../../../lib/__tests__/helpers/fakePg"));
vi.mock("next/headers", () => import("../../../lib/__tests__/helpers/fakeCookies"));
vi.mock("next/navigation", () => ({ notFound: navigation.notFound }));
vi.mock("../../../components/Canvas", () => ({
  default: (props: Record<string, unknown>) => {
    canvas.props.push(props);
    return <div data-testid="editor" />;
  },
}));

import * as cookies from "../../../lib/__tests__/helpers/fakeCookies";
import * as pg from "../../../lib/__tests__/helpers/fakePg";
import type { BoardRow } from "../../../lib/db";
import BoardPage from "../page";

/** A persisted element, as it comes back out of the jsonb column. */
const stored = (id: string, x = 0) => ({
  id,
  tool: "Square",
  x,
  y: 0,
  width: 40,
  height: 30,
});

const row = (overrides: Partial<BoardRow> = {}): BoardRow => ({
  id: "b1",
  title: "Sprint plan",
  owner_device_id: "device-a",
  owner_user_id: null,
  scene: [],
  viewport: { zoom: 2, scroll: { x: 40, y: 80 } },
  element_count: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  last_opened_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  ...overrides,
});

/** The `ensureBoard` insert returns nothing; the `getBoard` select returns rows. */
const boardIs = (found: BoardRow | null) =>
  pg.answerWith([], found ? [found] : []);

/** Render the page the way the router does, and hand back the editor's props. */
const openRoom = async (id = "b1", search: { adopt?: string } = {}) => {
  render(
    await BoardPage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve(search),
    }),
  );
  return canvas.props.at(-1)!;
};

beforeEach(() => {
  pg.reset();
  cookies.reset();
  canvas.props.length = 0;
  navigation.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the board it opens with", () => {
  it("paints the saved scene on the server, before the socket says anything", async () => {
    // The point of the whole page: the drawing is in the first HTML response, so
    // a board whose Redis snapshot has expired still opens with its contents.
    boardIs(row({ scene: [stored("kept")] as BoardRow["scene"] }));

    const props = await openRoom();

    expect(screen.getByTestId("editor")).toBeTruthy();
    expect((props.initialElements as { id: string }[]).map((e) => e.id)).toEqual([
      "kept",
    ]);
  });

  it("hands over the title and the viewport it was left at", async () => {
    boardIs(row());

    const props = await openRoom();

    expect(props.initialTitle).toBe("Sprint plan");
    expect(props.initialViewport).toEqual({ zoom: 2, scroll: { x: 40, y: 80 } });
  });

  it("is a room, and says which one", async () => {
    // `isCollaborative` is what opens the socket and shows the roster; the id is
    // both the board id and the room id.
    boardIs(row({ id: "V1StGXR8_Z" }));

    const props = await openRoom("V1StGXR8_Z");

    expect(props.isCollaborative).toBe(true);
    expect(props.boardId).toBe("V1StGXR8_Z");
    expect(props.initialTool).toBe("Select");
  });

  it("opens empty, and unzoomed, on a board with nothing saved yet", async () => {
    // The row exists — it was just created below — but nobody has drawn on it.
    boardIs(null);

    const props = await openRoom();

    expect(props.initialElements).toEqual([]);
    expect(props.initialTitle).toBeUndefined();
    expect(props.initialViewport).toBeNull();
  });

  it("drops a stored shape it cannot make sense of, rather than opening broken", async () => {
    /*
     * The column is jsonb written by whatever client last saved, including an
     * older version of this app. Hydration goes through `restoreElements`, so one
     * unreadable entry costs that entry and not the room.
     */
    boardIs(
      row({
        scene: [
          stored("real"),
          { id: "junk", tool: "Nonsense" },
          null,
        ] as unknown as BoardRow["scene"],
      }),
    );

    const props = await openRoom();

    expect((props.initialElements as { id: string }[]).map((e) => e.id)).toEqual([
      "real",
    ]);
  });
});

describe("following a link to a board that may not exist", () => {
  it("creates it, so a share link is never a dead end", async () => {
    // The board may only ever have lived in the other person's browser.
    boardIs(null);

    await openRoom("V1StGXR8_Z");

    expect(pg.flatten(pg.queries[0].text)).toContain("insert into boards");
    expect(pg.queries[0].params).toEqual(["V1StGXR8_Z", "device-a", null]);
    expect(pg.flatten(pg.queries[1].text)).toBe(
      "select * from boards where id = $1 and deleted_at is null",
    );
  });

  it("will not create one for a visitor with no cookie", async () => {
    /*
     * Middleware issues the device cookie on this same request, so this is a
     * visitor blocking cookies. A row created here would be owned by "" — nobody
     * could ever rename or delete it — so the read happens and the write does not.
     */
    cookies.setDeviceId("");
    boardIs(null);

    await openRoom();

    expect(pg.sql()).toEqual([
      "select * from boards where id = $1 and deleted_at is null",
    ]);
  });

  it("refuses an id that could never be a board", async () => {
    // Anything at all can appear in this path segment, and it goes on to be a
    // primary key: the shape is checked before the query layer sees it.
    await expect(openRoom("../../etc/passwd")).rejects.toThrow("NEXT_NOT_FOUND");

    expect(navigation.notFound).toHaveBeenCalledTimes(1);
    expect(pg.queries).toEqual([]);
    expect(pg.poolsCreated).toBe(0);
  });
});

describe("when the board store is unreachable", () => {
  it("still opens the editor, on an empty canvas", async () => {
    /*
     * Not a 500: without Postgres the app still draws, still keeps the scene in
     * localStorage and still collaborates over the socket. A thrown error in a
     * Server Component would replay in the browser as a render error instead.
     */
    pg.failWith(new Error("ECONNREFUSED 10.0.0.1:5432"));

    const props = await openRoom();

    expect(screen.getByTestId("editor")).toBeTruthy();
    expect(props.initialElements).toEqual([]);
    expect(props.initialViewport).toBeNull();
    expect(props.isCollaborative).toBe(true);
  });

  it("says why on the server, where it can be read", async () => {
    // Degrading silently would leave "my board is empty" with no explanation
    // anywhere.
    pg.failWith(new Error("ECONNREFUSED 10.0.0.1:5432"));

    await openRoom("b7");

    expect(console.error).toHaveBeenCalledWith(
      "Could not load board b7:",
      expect.any(Error),
    );
  });
});

describe("a room started from the local canvas", () => {
  it("carries the drawing that was on screen into it", async () => {
    // "Start a collaboration session" navigates here with `?adopt=local`; the
    // drawing exists only in this browser at that moment.
    boardIs(null);

    const props = await openRoom("b1", { adopt: "local" });

    expect(props.adoptLocalScene).toBe(true);
  });

  it("does not, on any other visit", async () => {
    boardIs(null);
    expect((await openRoom()).adoptLocalScene).toBe(false);

    cleanup();
    canvas.props.length = 0;
    boardIs(null);

    expect((await openRoom("b1", { adopt: "yes" })).adoptLocalScene).toBe(false);
  });
});
