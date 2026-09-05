// @vitest-environment jsdom
/**
 * Both pages with no `DATABASE_URL` — the configuration this project ships in.
 *
 * Postgres is the optional tier: without it the app still draws, still keeps the
 * scene in localStorage and still collaborates over the socket server, and only
 * saving to an account-less "my boards" is missing. Both of these pages are Server
 * Components, so the thing that has to be true is that neither of them *asks*. An
 * unguarded query would not degrade politely — `pg` with no connection string
 * dials 127.0.0.1:5432, fails once per address family, and hands back a bare
 * `AggregateError` that a Server Component replays into the browser as a render
 * error. The board would look broken rather than unsaved.
 *
 * It is a file of its own because `isDatabaseConfigured` is decided the moment
 * `app/lib/db` is first imported, so "not configured" cannot be arranged after the
 * imports have run.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const notice = vi.hoisted(() => {
  // Deleted rather than assumed absent: a Vitest worker is shared with the
  // suites that set it, as is the `globalThis` flag `db.ts` logs its notice by.
  delete process.env.DATABASE_URL;
  delete (globalThis as { __cdNoticeLogged?: boolean }).__cdNoticeLogged;

  const original = console.warn;
  console.warn = () => {};
  return { restore: () => (console.warn = original) };
});

const canvas = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
const dashboard = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock("pg", () => import("../lib/__tests__/helpers/fakePg"));
vi.mock("next/headers", () => import("../lib/__tests__/helpers/fakeCookies"));
vi.mock("../components/Canvas", () => ({
  default: (props: Record<string, unknown>) => {
    canvas.props.push(props);
    return <div data-testid="editor" />;
  },
}));
vi.mock("../components/Dashboard", () => ({
  default: (props: Record<string, unknown>) => {
    dashboard.props.push(props);
    return <div data-testid="gallery" />;
  },
}));

import * as cookies from "../lib/__tests__/helpers/fakeCookies";
import * as pg from "../lib/__tests__/helpers/fakePg";
import BoardPage from "../board/[id]/page";
import BoardsPage from "../boards/page";

const openRoom = async (search: { adopt?: string } = {}) => {
  render(
    await BoardPage({
      params: Promise.resolve({ id: "b1" }),
      searchParams: Promise.resolve(search),
    }),
  );
  return canvas.props.at(-1)!;
};

beforeEach(() => {
  pg.reset();
  cookies.reset();
  canvas.props.length = 0;
  dashboard.props.length = 0;
});

afterAll(() => {
  notice.restore();
  cleanup();
});

describe("a room with nowhere to save", () => {
  it("opens the editor on an empty canvas", async () => {
    const props = await openRoom();

    expect(screen.getByTestId("editor")).toBeTruthy();
    expect(props.initialElements).toEqual([]);
    expect(props.initialTitle).toBeUndefined();
    expect(props.initialViewport).toBeNull();
  });

  it("never opens a connection to look", async () => {
    // The whole point of the flag: no pool, no socket, no localhost:5432.
    await openRoom();

    expect(pg.poolsCreated).toBe(0);
    expect(pg.queries).toEqual([]);
  });

  it("is still a live room, the socket server being a separate tier", async () => {
    // Collaboration does not go through Postgres — losing the cloud tier must not
    // quietly turn a shared board into a private one.
    const props = await openRoom();

    expect(props.isCollaborative).toBe(true);
    expect(props.boardId).toBe("b1");
  });

  it("still carries the local drawing in when the session was just started", async () => {
    // With no board store, localStorage is the only place the drawing exists.
    expect((await openRoom({ adopt: "local" })).adoptLocalScene).toBe(true);
  });
});

describe("a gallery with no store behind it", () => {
  it("says so, rather than showing an empty shelf", async () => {
    // "No boards yet" would be a lie: there is no cloud to have boards in.
    render(await BoardsPage());

    expect(screen.getByTestId("gallery")).toBeTruthy();
    expect(dashboard.props.at(-1)!.unavailable).toBe(true);
    expect(dashboard.props.at(-1)!.boards).toEqual([]);
  });

  it("works that out without asking the database", async () => {
    await BoardsPage();

    expect(pg.poolsCreated).toBe(0);
    expect(pg.queries).toEqual([]);
  });
});
