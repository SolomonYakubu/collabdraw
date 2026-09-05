// @vitest-environment jsdom
/**
 * The saved-boards gallery.
 *
 * Everything here is either a request or a dialog, and the failure modes follow
 * from that:
 *
 *  - **Every card fetches its own thumbnail**, and the three outcomes are drawn
 *    differently on purpose. A shimmer, the drawing, or squared paper — because
 *    when "loading" and "no preview yet" looked the same, a gallery still loading
 *    looked like a gallery of blank boards.
 *  - **A request that comes back after the card is gone** must not write to it,
 *    which is what the `cancelled` flag in the effect is for.
 *  - **Rename and delete are optimistic in the list but not in the outcome**: the
 *    row is patched or dropped only once the server says so, and a refusal is a
 *    toast rather than a silently unchanged card.
 *  - **The dialogs replace `prompt()` and `confirm()`**, so the answer arrives in
 *    a callback; the board a dialog is asking about is held in one piece of state,
 *    and cancelling has to clear it.
 *
 * `next/link` is stubbed to a plain anchor: the real one wants the App Router
 * context, and what matters here is only where each card points.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";

import Dashboard from "../Dashboard";
import type { BoardSummary } from "../../lib/db";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const board = (over: Partial<BoardSummary> = {}): BoardSummary => ({
  id: "b1",
  title: "Sprint plan",
  owner_device_id: "device",
  element_count: 3,
  updated_at: ago(5 * MINUTE),
  last_opened_at: ago(5 * MINUTE),
  ...over,
});

/* --- the network ------------------------------------------------------------ */

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: unknown;
}

let calls: Call[];
/** What `/thumbnail` answers with; `"fail"` rejects the request outright. */
let preview: { dataUrl: string | null } | "fail";
/** Held open, to catch a card mid-request. */
let inFlight: Promise<void> | null;
let release: (() => void) | null;
/** Whether a rename or a delete is accepted. */
let writeOk: boolean;

const holdRequests = () => {
  inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
};

const writes = () => calls.filter((call) => call.method !== "GET");

/** Flush the microtask chain each card's fetch runs through. */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/* --- the component --------------------------------------------------------- */

type DashboardProps = ComponentProps<typeof Dashboard>;

const show = async (overrides: Partial<DashboardProps> = {}) => {
  const props: DashboardProps = { boards: [board()], ...overrides };
  const view = render(<Dashboard {...props} />);
  await settle();

  const update = (next: Partial<DashboardProps>) => {
    Object.assign(props, next);
    view.rerender(<Dashboard {...props} />);
  };

  return { ...view, update };
};

const card = (title: string) =>
  screen.getByRole("link", { name: `Open ${title}` }).closest("article") as HTMLElement;
const cards = () => screen.queryAllByRole("article");
const button = (name: string | RegExp) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
const maybe = (name: string | RegExp) => screen.queryByRole("button", { name });
const menu = () => screen.queryByRole("menu");
const openMenu = (title: string) => fireEvent.click(button(`Actions for ${title}`));
const choose = (label: string) =>
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
const dialog = () => screen.getByRole("dialog");
const toasts = () => screen.getByRole("status").textContent ?? "";
const searchField = () => screen.queryByLabelText("Search boards") as HTMLInputElement | null;

/* --- the environment ------------------------------------------------------- */

let copied: string[];
let clipboardWorks: boolean;

beforeEach(() => {
  calls = [];
  preview = { dataUrl: null };
  inFlight = null;
  release = null;
  writeOk = true;
  copied = [];
  clipboardWorks = true;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body, headers: init?.headers });

      if (inFlight) await inFlight;

      if (url.endsWith("/thumbnail")) {
        if (preview === "fail") throw new Error("offline");
        const payload = preview;
        return { ok: true, json: async () => payload } as Response;
      }
      return { ok: writeOk, status: writeOk ? 200 : 500 } as Response;
    }),
  );

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (!clipboardWorks) throw new Error("denied");
        copied.push(text);
      },
    },
  });

  // `useTheme` reads the system preference on mount; jsdom has no `matchMedia`.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("the gallery", () => {
  it("lists a card per board, pointing at the board", async () => {
    await show({
      boards: [board(), board({ id: "b2", title: "Retro" })],
    });

    expect(cards()).toHaveLength(2);
    expect(card("Retro").querySelector("a")!.getAttribute("href")).toBe("/board/b2");
  });

  it("counts the boards, and counts one board as one", async () => {
    // The line under the heading is the only place the total appears, and "1
    // boards" in a gallery of one is the kind of thing people notice first.
    const { update } = await show({ boards: [board()] });
    expect(screen.getByText("1 board saved on this device.")).toBeTruthy();

    update({ boards: [board(), board({ id: "b2", title: "Retro" })] });

    expect(screen.getByText("2 boards saved on this device.")).toBeTruthy();
  });

  it("counts the elements on each board, singular and plural", async () => {
    await show({
      boards: [
        board({ element_count: 1 }),
        board({ id: "b2", title: "Retro", element_count: 12 }),
      ],
    });

    expect(card("Sprint plan").textContent).toContain("1 item");
    expect(card("Retro").textContent).toContain("12 items");
  });

  it("takes a fresh list from the server over the one it is holding", async () => {
    // The page is server-rendered and revalidates; a list edited in place here
    // would go stale the moment another tab saved a board.
    const { update } = await show({ boards: [board()] });

    update({ boards: [board({ id: "b9", title: "From the server" })] });

    expect(cards()).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open From the server" })).toBeTruthy();
  });
});

describe("how long ago it was touched", () => {
  it.each([
    ["just now", 10],
    ["7m ago", 7 * MINUTE],
    ["3h ago", 3 * HOUR],
    ["4d ago", 4 * DAY],
  ])("reads %s", async (expected, age) => {
    await show({ boards: [board({ last_opened_at: ago(age) })] });

    expect(card("Sprint plan").textContent).toContain(expected);
  });

  it("falls back to a date once a relative time stops being useful", async () => {
    // "63d ago" is not a date; past a month the calendar is more informative.
    const long = ago(63 * DAY);
    await show({ boards: [board({ last_opened_at: long })] });

    expect(card("Sprint plan").textContent).toContain(
      new Date(long).toLocaleDateString(),
    );
  });

  it("prefers when you last opened it to when it last changed", async () => {
    /*
     * The gallery is ordered by the later of the two, so the card has to show the
     * same figure — otherwise the top board reads as the oldest.
     */
    await show({
      boards: [board({ updated_at: ago(9 * DAY), last_opened_at: ago(2 * MINUTE) })],
    });

    expect(card("Sprint plan").textContent).toContain("2m ago");
  });

  it("uses the changed time for a board that has never been opened", async () => {
    // `last_opened_at` is null for a board saved but not yet reopened; without
    // the fallback the card reads "Invalid Date".
    await show({
      boards: [
        board({
          updated_at: ago(3 * HOUR),
          last_opened_at: null as unknown as string,
        }),
      ],
    });

    expect(card("Sprint plan").textContent).toContain("3h ago");
  });
});

describe("the preview", () => {
  it("asks for one per board, and only for that board", async () => {
    await show({ boards: [board(), board({ id: "b2", title: "Retro" })] });

    expect(calls.map((call) => call.url)).toEqual([
      "/api/boards/b1/thumbnail",
      "/api/boards/b2/thumbnail",
    ]);
  });

  it("shimmers while the request is out", async () => {
    // A gallery of empty-looking cards that then fill in reads as broken; the
    // shimmer says the drawing is on its way.
    holdRequests();
    const { container } = await show();

    expect(container.querySelector(".skeleton")).toBeTruthy();
    expect(screen.queryByText("Not previewed yet")).toBeNull();
  });

  it("shows the drawing once it arrives", async () => {
    preview = { dataUrl: "data:image/png;base64,AAAA" };
    const { container } = await show();

    const image = container.querySelector("img.board-card__preview")!;
    expect(image.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    // Decorative: the card's own title is the accessible name of the link.
    expect(image.getAttribute("alt")).toBe("");
    expect(container.querySelector(".skeleton")).toBeNull();
  });

  it("says so plainly for a board with no preview stored", async () => {
    /*
     * Distinct from the shimmer on purpose. Squared paper and a caption say
     * "nothing has been drawn here yet", where a permanent shimmer would say
     * "still loading" forever.
     */
    preview = { dataUrl: null };
    const { container } = await show();

    expect(screen.getByText("Not previewed yet")).toBeTruthy();
    expect(container.querySelector(".dot-grid")).toBeTruthy();
    expect(container.querySelector(".skeleton")).toBeNull();
  });

  it("stops waiting when the request fails outright", async () => {
    // Offline, or a 500 that never parses: the card must settle into its empty
    // state rather than shimmer for the rest of the session.
    preview = "fail";
    await show();

    expect(screen.getByText("Not previewed yet")).toBeTruthy();
  });

  it("does not write to a card that has already gone", async () => {
    /*
     * A reply landing after the gallery unmounts — navigating away while the
     * previews are still out is the ordinary case — would otherwise set state on a
     * dead component, which React reports as an error on the console.
     */
    const complaints = vi.spyOn(console, "error").mockImplementation(() => {});
    holdRequests();
    const { unmount } = await show();

    unmount();
    release!();
    await settle();

    expect(complaints).not.toHaveBeenCalled();
  });
});

describe("with nothing saved", () => {
  it("explains how a board gets here", async () => {
    // The gallery is reachable before anything has ever been saved, and an empty
    // grid alone does not say what to do about it.
    await show({ boards: [] });

    expect(screen.getByText("No saved boards yet")).toBeTruthy();
    expect(screen.getByText("Save to my boards")).toBeTruthy();
    expect(
      screen.getByText("Boards you save from the canvas show up here."),
    ).toBeTruthy();
    expect(cards()).toHaveLength(0);
  });

  it("offers the canvas twice — in the bar and in the empty state itself", async () => {
    await show({ boards: [] });

    expect(screen.getAllByRole("link", { name: /Open canvas/ })).toHaveLength(2);
  });
});

describe("when the board store cannot be reached", () => {
  it("says the list is unavailable rather than letting it read as empty", async () => {
    /*
     * The distinction the `unavailable` prop exists for: "you have no boards" and
     * "we cannot see your boards" look identical in an empty grid, and only one of
     * them means the drawing in the browser is at risk of feeling lost.
     */
    await show({ boards: [], unavailable: true });

    expect(screen.getByText(/Saved boards are unavailable right now/)).toBeTruthy();
  });

  it("keeps the warning above whatever boards it did manage to show", async () => {
    await show({ boards: [board()], unavailable: true });

    expect(screen.getByText(/Saved boards are unavailable right now/)).toBeTruthy();
    expect(cards()).toHaveLength(1);
  });

  it("stays quiet when the store is fine", async () => {
    await show();

    expect(screen.queryByText(/Saved boards are unavailable/)).toBeNull();
  });
});

const FOUR = [
  board({ id: "b1", title: "Sprint plan" }),
  board({ id: "b2", title: "Retro" }),
  board({ id: "b3", title: "Roadmap" }),
  board({ id: "b4", title: "Onboarding" }),
];

describe("the search field", () => {
  it("stays away until the grid is worth searching", async () => {
    // Three cards are faster to read than to filter, and the field would only
    // crowd the heading.
    await show({ boards: FOUR.slice(0, 3) });

    expect(searchField()).toBeNull();
  });

  it("appears once there are enough boards to scan", async () => {
    await show({ boards: FOUR });

    expect(searchField()).toBeTruthy();
  });

  it("filters on the title, whatever case it is typed in", async () => {
    await show({ boards: FOUR });

    fireEvent.change(searchField()!, { target: { value: "ro" } });

    // "Retro" matches in the middle and "Roadmap" at the start — a substring, and
    // a capital R found by a lowercase r.
    expect(cards()).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Open Sprint plan" })).toBeNull();
  });

  it("says when nothing matches, quoting what was searched for", async () => {
    // Otherwise a mistyped query looks like every board has been deleted.
    await show({ boards: FOUR });

    fireEvent.change(searchField()!, { target: { value: "  budget  " } });

    expect(screen.getByText("No board matches “budget”.")).toBeTruthy();
    expect(cards()).toHaveLength(0);
  });

  it("offers a way to clear itself only once there is something to clear", async () => {
    await show({ boards: FOUR });
    expect(maybe("Clear search")).toBeNull();

    fireEvent.change(searchField()!, { target: { value: "retro" } });
    fireEvent.click(button("Clear search"));

    expect(searchField()!.value).toBe("");
    expect(cards()).toHaveLength(4);
  });

  it("keeps the empty state for an empty gallery rather than a search field", async () => {
    // Nothing to search, and the invitation to draw is the whole point of the
    // page in that state.
    await show({ boards: [] });

    expect(searchField()).toBeNull();
    expect(screen.getByText("No saved boards yet")).toBeTruthy();
  });
});

describe("the card menu", () => {
  it("is always on the card, since a touch device never hovers", async () => {
    // A hover-only control would put rename and delete out of reach on a phone.
    await show();

    expect(button("Actions for Sprint plan")).toBeTruthy();
  });

  it("says that it opens a menu, and whether it is open", async () => {
    await show();
    const trigger = button("Actions for Sprint plan");

    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    openMenu("Sprint plan");

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menu()).toBeTruthy();
  });

  it("offers the three things you can do to a saved board", async () => {
    await show();

    openMenu("Sprint plan");

    expect(
      screen.getAllByRole("menuitem").map((entry) => entry.textContent),
    ).toEqual(["Rename", "Copy link", "Delete"]);
  });

  it("closes on a press outside it", async () => {
    await show();
    openMenu("Sprint plan");

    fireEvent.pointerDown(document.body);

    expect(menu()).toBeNull();
  });

  it("stays open for a press on itself", async () => {
    // The press that lands on an item is a press inside; closing on it would
    // unmount the item before the click could choose it.
    await show();
    openMenu("Sprint plan");

    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Rename" }));

    expect(menu()).toBeTruthy();
  });

  it("closes on Escape", async () => {
    await show();
    openMenu("Sprint plan");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(menu()).toBeNull();
  });

  it("ignores other keys", async () => {
    await show();
    openMenu("Sprint plan");

    fireEvent.keyDown(document, { key: "r" });

    expect(menu()).toBeTruthy();
  });

  it("takes its listeners with it, on close and on unmount", async () => {
    /*
     * Both are on `document`, and a gallery of twenty cards would otherwise leave
     * twenty handlers behind — each of them closing a menu that is already gone.
     */
    const { unmount } = await show();
    openMenu("Sprint plan");
    openMenu("Sprint plan");

    expect(() => {
      fireEvent.pointerDown(document.body);
      fireEvent.keyDown(document, { key: "Escape" });
    }).not.toThrow();

    openMenu("Sprint plan");
    unmount();

    expect(() =>
      fireEvent.keyDown(document, { key: "Escape" }),
    ).not.toThrow();
  });

  it("gets out of the way before the thing it was asked to do happens", async () => {
    // Rename opens a dialog over the card; a menu left open would sit on top of
    // it, and its outside-press listener would fight the dialog's.
    await show();
    openMenu("Sprint plan");

    choose("Rename");

    expect(menu()).toBeNull();
    expect(dialog()).toBeTruthy();
  });

  it("names itself for the board it belongs to", async () => {
    // Twenty identical "More" buttons are unusable with a screen reader.
    await show({ boards: [board(), board({ id: "b2", title: "Retro" })] });

    expect(button("Actions for Retro")).toBeTruthy();
    expect(within(card("Retro")).getByRole("button")).toBe(
      button("Actions for Retro"),
    );
  });
});

/** Rename via the menu, leaving the dialog open on the given board. */
const startRename = async (title = "Sprint plan") => {
  openMenu(title);
  choose("Rename");
};

/**
 * The dialog's field. Not `getByLabelText("Board title")`: the dialog itself is
 * labelled by its heading, so that name matches two elements.
 */
const titleField = () => within(dialog()).getByRole("textbox") as HTMLInputElement;
const type = (value: string) => fireEvent.change(titleField(), { target: { value } });

describe("renaming a board", () => {
  it("asks in a dialog seeded with the name it has", async () => {
    // `prompt()` cannot be styled or themed and says "localhost:3000 says"; this
    // is its replacement, and it starts from the current title so a small
    // correction is a small edit.
    await show();

    await startRename();

    expect(dialog().textContent).toContain("Board title");
    expect(titleField().value).toBe("Sprint plan");
  });

  it("sends the new title, and shows it on the card", async () => {
    await show();
    await startRename();

    type("Q3 roadmap");
    fireEvent.click(button("Rename"));
    await settle();

    expect(writes()).toEqual([
      {
        url: "/api/boards/b1",
        method: "PATCH",
        body: JSON.stringify({ title: "Q3 roadmap" }),
        headers: { "content-type": "application/json" },
      },
    ]);
    expect(screen.getByRole("link", { name: "Open Q3 roadmap" })).toBeTruthy();
    expect(toasts()).toContain("Board renamed");
  });

  it("says nothing to the server when the name was not changed", async () => {
    /*
     * Opening the dialog and pressing Rename is not an edit. A request here would
     * bump `updated_at` and reorder the gallery under the user for nothing.
     */
    await show();
    await startRename();

    fireEvent.click(button("Rename"));
    await settle();

    expect(writes()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the old name and says so when the server refuses", async () => {
    // The card must not show a title the store does not have; the next reload
    // would silently undo it.
    writeOk = false;
    await show();
    await startRename();

    type("Renamed");
    fireEvent.click(button("Rename"));
    await settle();

    expect(screen.getByRole("link", { name: "Open Sprint plan" })).toBeTruthy();
    expect(toasts()).toContain("Could not rename that board.");
  });

  it("leaves everything alone when the dialog is cancelled", async () => {
    await show();
    await startRename();

    fireEvent.click(button("Cancel"));
    await settle();

    expect(writes()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("link", { name: "Open Sprint plan" })).toBeTruthy();
  });

  it("dims the card while the request is out", async () => {
    /*
     * The card is also a link, and a second click during a rename would open the
     * board mid-request. Dimming it and turning off its pointer events is the
     * whole of the busy state.
     */
    await show();
    await startRename();
    type("Renamed");

    holdRequests();
    fireEvent.click(button("Rename"));
    await settle();

    expect(cards()[0].style.opacity).toBe("0.5");
    expect(cards()[0].style.pointerEvents).toBe("none");

    release!();
    await settle();

    expect(cards()[0].style.opacity).toBe("1");
    expect(cards()[0].style.pointerEvents).toBe("");
  });
});

describe("deleting a board", () => {
  it("asks first, naming the board and saying it cannot be undone", async () => {
    /*
     * The drawing goes with it, and there is no undo on this page — so the dialog
     * has to name which board, since the menu it came from is already closed.
     */
    await show();

    openMenu("Sprint plan");
    choose("Delete");

    expect(dialog().textContent).toContain("Delete this board?");
    expect(dialog().textContent).toContain("“Sprint plan”");
    expect(dialog().textContent).toContain("cannot be undone");
  });

  it("deletes it, drops the card and says which one went", async () => {
    // The toast quotes the title because the card it referred to is gone by the
    // time the message is read.
    await show({ boards: [board(), board({ id: "b2", title: "Retro" })] });

    openMenu("Sprint plan");
    choose("Delete");
    fireEvent.click(button("Delete"));
    await settle();

    expect(writes()).toEqual([
      { url: "/api/boards/b1", method: "DELETE", body: undefined, headers: undefined },
    ]);
    expect(cards()).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open Retro" })).toBeTruthy();
    expect(toasts()).toContain("Deleted “Sprint plan”");
  });

  it("keeps the card when the server refuses", async () => {
    // Dropping it optimistically would hide a board that still exists, and the
    // next reload would bring it back with no explanation.
    writeOk = false;
    await show();

    openMenu("Sprint plan");
    choose("Delete");
    fireEvent.click(button("Delete"));
    await settle();

    expect(cards()).toHaveLength(1);
    expect(toasts()).toContain("Could not delete that board.");
  });

  it("does nothing at all when the question is declined", async () => {
    await show();

    openMenu("Sprint plan");
    choose("Delete");
    fireEvent.click(button("Cancel"));
    await settle();

    expect(writes()).toEqual([]);
    expect(cards()).toHaveLength(1);
  });

  it("forgets which board it was asking about", async () => {
    /*
     * One piece of state holds the board a dialog is about. Left set after a
     * cancel, the next "Delete" on another card would confirm against the first.
     */
    await show({ boards: [board(), board({ id: "b2", title: "Retro" })] });
    openMenu("Sprint plan");
    choose("Delete");
    fireEvent.click(button("Cancel"));

    openMenu("Retro");
    choose("Delete");

    expect(dialog().textContent).toContain("“Retro”");
  });
});

describe("copying a link to a board", () => {
  it("copies an absolute URL, which is what a colleague can open", async () => {
    // A relative path on the clipboard is useless in a chat window.
    await show();

    openMenu("Sprint plan");
    choose("Copy link");
    await settle();

    expect(copied).toEqual([`${window.location.origin}/board/b1`]);
    expect(toasts()).toContain("Link copied");
  });

  it("says so when the clipboard is not available", async () => {
    /*
     * Denied on an insecure origin and by some browsers outright. Silence there
     * looks like a successful copy, and the paste is what fails instead.
     */
    clipboardWorks = false;
    await show();

    openMenu("Sprint plan");
    choose("Copy link");
    await settle();

    expect(copied).toEqual([]);
    expect(toasts()).toContain("Could not copy that link.");
  });

  it("does not touch the server", async () => {
    // The link is built from the board id that is already on the page.
    await show();

    openMenu("Sprint plan");
    choose("Copy link");
    await settle();

    expect(writes()).toEqual([]);
  });
});

describe("the theme button", () => {
  it("says which theme is on and that pressing it changes that", async () => {
    // The gallery is a separate page from the canvas, and the same three-state
    // cycle has to be reachable from it.
    await show();

    expect(button("Theme: system. Click to change.")).toBeTruthy();
  });

  it("cycles on to the next theme", async () => {
    await show();

    fireEvent.click(button("Theme: system. Click to change."));

    expect(button("Theme: light. Click to change.")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("shows a different glyph for each of the three, and comes back round", async () => {
    /*
     * Three states, not two: "dark" and "following a system that is currently
     * dark" are the same colours on screen, and the icon is the only thing that
     * distinguishes them.
     */
    await show();
    const glyph = () =>
      screen.getByRole("button", { name: /^Theme: / }).innerHTML;
    const asSystem = glyph();

    fireEvent.click(button(/^Theme: /));
    const asLight = glyph();
    fireEvent.click(button(/^Theme: /));
    const asDark = glyph();

    expect(new Set([asSystem, asLight, asDark]).size).toBe(3);
    expect(button("Theme: dark. Click to change.").getAttribute("title")).toBe(
      "Theme: dark",
    );

    fireEvent.click(button(/^Theme: /));

    expect(glyph()).toBe(asSystem);
  });
});

describe("getting back to the canvas", () => {
  it("offers it in the bar, beside the app's own name", async () => {
    // The gallery is a dead end otherwise: boards are made on the canvas.
    await show();

    expect(screen.getByRole("link", { name: /Open canvas/ }).getAttribute("href")).toBe(
      "/",
    );
    expect(screen.getByText("CollabDraw")).toBeTruthy();
  });
});
