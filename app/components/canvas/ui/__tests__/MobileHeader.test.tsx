// @vitest-environment jsdom
/**
 * The phone top bar, and the menu drawer under it.
 *
 * The bar is two islands pinned to the top corners, and almost everything in it
 * is conditional — a phone has no room for a control that does nothing. So the
 * tests are mostly about what appears when:
 *
 *  - The connection badge and the roster exist only on a shared board. On a local
 *    canvas "Off" beside a hamburger would suggest something is broken.
 *  - The roster is asked to open *leftwards*, because this button sits at the left
 *    end of the row; right-aligned it would hang off the side of a phone.
 *  - The share button's label is the only thing that says a copy happened — there
 *    is no toast — so it carries "Link copied" while the state is up.
 *  - The drawer shares `MainMenuList` with the desktop hamburger, and hands it
 *    `onToggleMenu` as the after-select hook: an item's effect is on the canvas
 *    behind a full-screen drawer, so the drawer has to get out of the way.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MobileHeader, { type MobileHeaderProps } from "../MobileHeader";
import type { MainMenuItem } from "../MainMenu";

const menuItem = (
  id: string,
  label: string,
  extra: Partial<MainMenuItem> = {},
): MainMenuItem => ({
  id,
  label,
  icon: <svg data-testid={`icon-${id}`} />,
  onSelect: vi.fn(),
  ...extra,
});

/** Only what a local board passes; the collaborative half is opt-in. */
const show = (overrides: Partial<MobileHeaderProps> = {}) => {
  const props: MobileHeaderProps = {
    canUndo: true,
    canRedo: true,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    menuItems: [menuItem("export", "Export as PNG")],
    isMenuOpen: false,
    onToggleMenu: vi.fn(),
    ...overrides,
  };
  const view = render(<MobileHeader {...props} />);

  const update = (next: Partial<MobileHeaderProps>) => {
    Object.assign(props, next);
    view.rerender(<MobileHeader {...props} />);
  };

  return { ...view, props, update };
};

const button = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
const maybe = (name: string) => screen.queryByRole("button", { name });
const hamburger = () => button("Open main menu");
const drawer = () => document.querySelector<HTMLElement>(".animate-slide-up");
const backdrop = () => document.querySelector<HTMLElement>('[class*="bg-black/40"]');
const entry = (name: string | RegExp) =>
  screen.getByRole("menuitem", { name }) as HTMLButtonElement;

const SHARED = {
  isCollaborative: true,
  isConnected: true,
  users: [
    { id: "me", tag: "Ada" },
    { id: "peer", tag: "Grace" },
  ],
  currentUserId: "me",
  userName: "Ada",
  onRenameUser: vi.fn(() => true),
} satisfies Partial<MobileHeaderProps>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("what a local board shows", () => {
  it("is a landmark, being the top of the page", () => {
    show();

    expect(screen.getByRole("banner")).toBeTruthy();
  });

  it("keeps to the menu and the history when there is nothing else to offer", () => {
    // No socket, no assistant, no link to share: three buttons, and no "Off"
    // badge suggesting a connection has dropped.
    show();

    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(maybe("Collaborators")).toBeNull();
    expect(maybe("Assistant")).toBeNull();
    expect(maybe("Share link")).toBeNull();
    expect(screen.queryByText("Off")).toBeNull();
  });
});

describe("the hamburger", () => {
  it("says whether the drawer is up, and turns into a cross while it is", () => {
    // The button does not move when the drawer opens, so the glyph is what says
    // that pressing it again will close rather than open.
    const { update } = show();
    const asMenu = hamburger().innerHTML;

    expect(hamburger().getAttribute("aria-expanded")).toBe("false");

    update({ isMenuOpen: true });

    expect(hamburger().getAttribute("aria-expanded")).toBe("true");
    expect(hamburger().innerHTML).not.toBe(asMenu);
  });

  it("toggles the drawer", () => {
    const { props } = show();

    fireEvent.click(hamburger());

    expect(props.onToggleMenu).toHaveBeenCalledTimes(1);
  });
});

describe("the connection badge", () => {
  it("says the board is live", () => {
    show({ ...SHARED, isConnected: true });

    expect(screen.getByLabelText("Connected").textContent).toBe("Live");
  });

  it("says so when the socket has gone", () => {
    /*
     * Strokes still land on the local canvas while the socket is down, so without
     * this the board looks perfectly normal and the work is quietly not shared.
     */
    show({ ...SHARED, isConnected: false });

    expect(screen.getByLabelText("Offline").textContent).toBe("Off");
  });

  it("stays away entirely on a board that is not shared", () => {
    show({ isCollaborative: false });

    expect(screen.queryByLabelText("Connected")).toBeNull();
    expect(screen.queryByLabelText("Offline")).toBeNull();
  });
});

describe("the collaborators", () => {
  it("comes with the room, count and all", () => {
    show(SHARED);

    expect(button("Collaborators").textContent).toBe("2");
  });

  it("opens its roster leftwards, this button being at the left of the bar", () => {
    /*
     * Right-aligning a panel to a button 8px from the left edge would put it at
     * −176 and hide most of the roster off the side of the phone. jsdom has no
     * layout, so the button's rect is supplied.
     */
    show(SHARED);
    vi.spyOn(button("Collaborators"), "getBoundingClientRect").mockReturnValue({
      top: 12,
      bottom: 48,
      left: 52,
      right: 92,
      width: 40,
      height: 36,
      x: 52,
      y: 12,
      toJSON: () => ({}),
    });

    fireEvent.click(button("Collaborators"));

    expect(document.querySelector<HTMLElement>(".island.fixed")!.style.left).toBe(
      "52px",
    );
  });
});

describe("undo and redo", () => {
  it("goes dim at the ends of the history", () => {
    show({ canUndo: false, canRedo: false });

    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);
  });

  it("works", () => {
    const { props } = show();

    fireEvent.click(button("Undo"));
    fireEvent.click(button("Redo"));

    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(props.onRedo).toHaveBeenCalledTimes(1);
  });
});

describe("the assistant button", () => {
  it("appears only where the assistant does", () => {
    show();

    expect(maybe("Assistant")).toBeNull();
  });

  it("toggles the panel and shows that it is open", () => {
    const onToggleAI = vi.fn();
    const { update } = show({ onToggleAI });

    fireEvent.click(button("Assistant"));
    expect(onToggleAI).toHaveBeenCalledTimes(1);

    update({ isAIPanelOpen: true });

    expect(button("Assistant").getAttribute("aria-pressed")).toBe("true");
    expect(button("Assistant").getAttribute("data-active")).toBe("true");
  });

  it("spins while a drawing is being generated", () => {
    // The request outlives the panel being closed, and on a phone the panel
    // covers the screen — so the bar is where "still working" has to show.
    show({ onToggleAI: vi.fn(), isAiGenerating: true });

    expect(button("Assistant").querySelector(".animate-spin")).toBeTruthy();
  });

  it("marks a reply that arrived behind the closed panel", () => {
    show({ onToggleAI: vi.fn(), aiConversationCount: 2 });

    expect(button("Assistant").querySelector(".rounded-full")).toBeTruthy();
  });

  it("does not show the dot and the spinner at once", () => {
    // They share the same corner, and "working" already implies a conversation.
    show({ onToggleAI: vi.fn(), aiConversationCount: 2, isAiGenerating: true });

    expect(button("Assistant").querySelectorAll(".rounded-full")).toHaveLength(1);
    expect(button("Assistant").querySelector(".animate-spin")).toBeTruthy();
  });

  it("shows neither on a conversation that has not started", () => {
    show({ onToggleAI: vi.fn(), aiConversationCount: 0 });

    expect(button("Assistant").querySelector(".animate-spin")).toBeNull();
    expect(button("Assistant").querySelector(".rounded-full")).toBeNull();
  });
});

describe("the share button", () => {
  it("appears only when there is something to share", () => {
    show();

    expect(maybe("Share link")).toBeNull();
  });

  it("shares, under a plain label by default", () => {
    const onShare = vi.fn();
    show({ onShare });

    fireEvent.click(button("Share link"));

    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it("takes the caller's word for what sharing means here", () => {
    // On a local canvas the same button starts a session rather than copying a
    // link to one that exists.
    show({ onShare: vi.fn(), shareLabel: "Start a collaboration session" });

    expect(button("Start a collaboration session")).toBeTruthy();
  });

  it("becomes the confirmation once the link is copied", () => {
    /*
     * A clipboard write produces nothing visible and there is no toast, so the
     * button itself has to report it — in its label, its tint and its glyph.
     */
    const { update } = show({ onShare: vi.fn(), shareLabel: "Copy share link" });
    const asLink = button("Copy share link").innerHTML;

    update({ linkCopied: true });

    expect(button("Link copied").getAttribute("data-active")).toBe("true");
    expect(button("Link copied").innerHTML).not.toBe(asLink);
  });
});

describe("the drawer", () => {
  it("is not there until it is opened", () => {
    show();

    expect(drawer()).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("holds the same items as the desktop menu", () => {
    // One definition of "what is in the menu", rendered by `MainMenuList` in both
    // places; two lists would drift.
    show({
      isMenuOpen: true,
      menuItems: [
        menuItem("export", "Export as PNG"),
        menuItem("reset", "Reset the canvas", { danger: true }),
      ],
    });

    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    expect(entry(/Reset the canvas/).style.color).toBe("var(--danger)");
  });

  it("closes itself once an item has been chosen", () => {
    // The drawer covers the canvas, and the canvas is where the item's effect
    // shows up.
    const items = [menuItem("export", "Export as PNG")];
    const { props } = show({ isMenuOpen: true, menuItems: items });

    fireEvent.click(entry(/Export as PNG/));

    expect(items[0].onSelect).toHaveBeenCalledTimes(1);
    expect(props.onToggleMenu).toHaveBeenCalledTimes(1);
  });

  it("closes on the backdrop, which is the whole rest of the screen", () => {
    // A tap beside the drawer is the usual way out of a sheet on a phone; there
    // is no Escape key to reach for.
    const { props } = show({ isMenuOpen: true });

    fireEvent.click(backdrop()!);

    expect(props.onToggleMenu).toHaveBeenCalledTimes(1);
  });

  it("closes on its own cross", () => {
    const { props } = show({ isMenuOpen: true });

    fireEvent.click(button("Close menu"));

    expect(props.onToggleMenu).toHaveBeenCalledTimes(1);
  });
});
