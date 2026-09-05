// @vitest-environment jsdom
/**
 * `/boards` — the gallery of boards this browser has saved.
 *
 * There are no accounts, so "my boards" means the device cookie: the page reads
 * it, asks for that device's boards, and hands the list to the dashboard. What is
 * worth pinning is the three ways it can come back empty, because they are not
 * the same thing to a visitor:
 *
 *  - No board store configured, or one that failed: the dashboard shows its
 *    notice, because the boards may exist and simply be out of reach.
 *  - No device cookie: nothing has ever been saved from this browser, so the
 *    right answer is the empty gallery rather than a warning about the cloud.
 *
 * As with the room, a failure here degrades instead of throwing: this is a Server
 * Component, and an error thrown in one reaches the browser as a render error.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://u:p@db.example.com/app?sslmode=require";
});

/** The dashboard has its own tests; here it is a set of props. */
const dashboard = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock("pg", () => import("../../lib/__tests__/helpers/fakePg"));
vi.mock("next/headers", () => import("../../lib/__tests__/helpers/fakeCookies"));
vi.mock("../../components/Dashboard", () => ({
  default: (props: Record<string, unknown>) => {
    dashboard.props.push(props);
    return <div data-testid="gallery" />;
  },
}));

import * as cookies from "../../lib/__tests__/helpers/fakeCookies";
import * as pg from "../../lib/__tests__/helpers/fakePg";
import type { BoardSummary } from "../../lib/db";
import BoardsPage from "../page";

const summary = (id: string, title: string): BoardSummary => ({
  id,
  title,
  owner_device_id: "device-a",
  element_count: 3,
  updated_at: "2026-01-01T00:00:00.000Z",
  last_opened_at: "2026-01-02T00:00:00.000Z",
});

const openGallery = async () => {
  render(await BoardsPage());
  return dashboard.props.at(-1)!;
};

beforeEach(() => {
  pg.reset();
  cookies.reset();
  dashboard.props.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the gallery it renders", () => {
  it("lists what this device has saved", async () => {
    pg.answerWith([summary("b1", "Sprint plan"), summary("b2", "架構圖")]);

    const props = await openGallery();

    expect(screen.getByTestId("gallery")).toBeTruthy();
    expect((props.boards as BoardSummary[]).map((b) => b.title)).toEqual([
      "Sprint plan",
      "架構圖",
    ]);
    expect(props.unavailable).toBe(false);
  });

  it("asks for one device's boards, not everyone's", async () => {
    // There is no login: the cookie is the whole of the authorization, so the
    // parameter is the one thing keeping one browser's gallery out of another's.
    cookies.setDeviceId("device-b");
    pg.answerWith([]);

    await openGallery();

    expect(pg.queries).toHaveLength(1);
    expect(pg.queries[0].params).toEqual(["device-b"]);
  });
});

describe("when there is nothing to show", () => {
  it("shows the notice when the query fails", async () => {
    /*
     * The boards are probably fine and simply out of reach, so this cannot look
     * like an empty gallery — that would read as "my drawings are gone".
     */
    pg.failWith(new Error("ECONNREFUSED 10.0.0.1:5432"));

    const props = await openGallery();

    expect(props.unavailable).toBe(true);
    expect(props.boards).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      "Could not list boards:",
      expect.any(Error),
    );
  });

  it("shows an empty gallery, not a warning, to a browser that has never saved", async () => {
    // No device cookie is the normal state of a first visit with cookies blocked.
    // The cloud is working; this browser has simply never put anything in it.
    cookies.setDeviceId("");

    const props = await openGallery();

    expect(props.boards).toEqual([]);
    expect(props.unavailable).toBe(false);
    expect(pg.queries).toEqual([]);
    expect(pg.poolsCreated).toBe(0);
  });
});
