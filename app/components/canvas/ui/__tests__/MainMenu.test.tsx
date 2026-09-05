// @vitest-environment jsdom
/**
 * The hamburger menu, and the item list it shares with the mobile drawer.
 *
 * `MainMenuList` is exported precisely so that "what is in the menu" has one
 * definition rather than two that drift — the drawer in `MobileHeader` renders
 * the same array. It is tested on its own here for that reason: its contract is
 * used by a component that is not this one.
 *
 * The popover around it holds the only state, and every failure worth guarding is
 * a way of getting stuck with it open: choosing an item has to close it (a menu
 * left open covers the drawing the item just changed), and so do Escape and a
 * press outside — with the listeners attached only while it is open, since they
 * are on `window`.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MainMenu, { MainMenuList, type MainMenuItem } from "../MainMenu";

const item = (
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

const DEFAULTS = () => [
  item("export", "Export as PNG"),
  item("theme", "Theme", { hint: "Dark" }),
  item("reset", "Reset the canvas", { danger: true, separatorBefore: true }),
];

const show = (items: MainMenuItem[] = DEFAULTS()) => {
  const view = render(<MainMenu items={items} />);
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Main menu" }));
  return { ...view, items, open };
};

const hamburger = () => screen.getByRole("button", { name: "Main menu" });
const entry = (name: string | RegExp) =>
  screen.getByRole("menuitem", { name }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the item list, wherever it is rendered", () => {
  it("shows each item's label, icon and hint", () => {
    // The hint is how the theme item says which theme is on without a second row
    // of text.
    render(<MainMenuList items={DEFAULTS()} />);

    expect(entry(/Export as PNG/)).toBeTruthy();
    expect(screen.getByTestId("icon-export")).toBeTruthy();
    expect(entry(/Theme/).textContent).toContain("Dark");
  });

  it("hides the icons from screen readers, the label being the name", () => {
    // Otherwise every item is announced twice — once as a graphic, once as text.
    const { container } = render(<MainMenuList items={[item("export", "Export as PNG")]} />);

    expect(
      container.querySelector('[aria-hidden="true"]')!.contains(
        screen.getByTestId("icon-export"),
      ),
    ).toBe(true);
  });

  it("groups with a divider, but never draws one above the first item", () => {
    const { container } = render(
      <MainMenuList
        items={[
          item("export", "Export as PNG", { separatorBefore: true }),
          item("reset", "Reset the canvas", { separatorBefore: true }),
        ]}
      />,
    );

    expect(container.querySelectorAll(".divider")).toHaveLength(1);
  });

  it("runs the item, then tells its host it is done", () => {
    // The host uses that second call to close itself; the order matters, since
    // closing unmounts the button that was clicked.
    const order: string[] = [];
    const items = [item("export", "Export as PNG", { onSelect: () => order.push("selected") })];
    render(<MainMenuList items={items} onAfterSelect={() => order.push("closed")} />);

    fireEvent.click(entry(/Export as PNG/));

    expect(order).toEqual(["selected", "closed"]);
  });

  it("works for a host that does not care when it is done", () => {
    // The drawer passes a callback; a caller that renders the list inline need
    // not, and the optional call must not throw.
    const items = [item("export", "Export as PNG")];
    render(<MainMenuList items={items} />);

    expect(() => fireEvent.click(entry(/Export as PNG/))).not.toThrow();
    expect(items[0].onSelect).toHaveBeenCalledTimes(1);
  });

  it("leaves an unavailable item inert and faint", () => {
    // "Save to the board" with no board open, for instance: listed, so the menu
    // has a stable shape, but not clickable.
    const items = [item("save", "Save the board", { disabled: true })];
    render(<MainMenuList items={items} />);

    expect(entry(/Save the board/).disabled).toBe(true);
    expect(entry(/Save the board/).style.color).toBe("var(--text-faint)");
    expect(entry(/Save the board/).style.cursor).toBe("not-allowed");
    fireEvent.click(entry(/Save the board/));

    expect(items[0].onSelect).not.toHaveBeenCalled();
  });

  it("colours a destructive item as one", () => {
    // "Reset the canvas" throws the drawing away; it does not look like "Theme".
    render(<MainMenuList items={DEFAULTS()} />);

    expect(entry(/Reset the canvas/).style.color).toBe("var(--danger)");
    expect(entry(/Export as PNG/).style.color).toBe("var(--text)");
  });

  it("highlights under the pointer in the item's own colour", () => {
    render(<MainMenuList items={DEFAULTS()} />);

    fireEvent.mouseEnter(entry(/Reset the canvas/));
    fireEvent.mouseEnter(entry(/Export as PNG/));

    expect(entry(/Reset the canvas/).style.background).toBe("var(--danger-bg)");
    expect(entry(/Export as PNG/).style.background).toBe("var(--hover-bg)");

    fireEvent.mouseLeave(entry(/Export as PNG/));

    expect(entry(/Export as PNG/).style.background).toBe("transparent");
  });

  it("does not highlight what cannot be chosen", () => {
    render(<MainMenuList items={[item("save", "Save the board", { disabled: true })]} />);

    fireEvent.mouseEnter(entry(/Save the board/));

    expect(entry(/Save the board/).style.background).toBe("transparent");
  });
});

describe("the hamburger", () => {
  it("starts closed, with the drawing unobscured", () => {
    show();

    expect(screen.queryByRole("menu")).toBeNull();
    expect(hamburger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on the first press and closes on the second", () => {
    const { open } = show();

    open();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(hamburger().getAttribute("aria-expanded")).toBe("true");

    open();

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says it opens a menu, so it is not read as a plain button", () => {
    show();

    expect(hamburger().getAttribute("aria-haspopup")).toBe("menu");
  });

  it("closes itself once an item has been chosen", () => {
    // The item's own effect — an export, a theme change — is on the canvas
    // behind the popover, and the user needs to see it.
    const { open, items } = show();
    open();

    fireEvent.click(entry(/Export as PNG/));

    expect(items[0].onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape", () => {
    const { open } = show();
    open();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ignores keys that are not Escape", () => {
    // The tool shortcuts keep working while the menu is open.
    const { open } = show();
    open();

    fireEvent.keyDown(window, { key: "v" });

    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on a press outside it", () => {
    const { open } = show();
    open();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays open for a press on itself", () => {
    /*
     * The listener is in the capture phase on `window`, so it sees the press that
     * lands on an item before the click does. Closing on it would unmount the
     * item before it could be chosen.
     */
    const { open } = show();
    open();

    fireEvent.pointerDown(entry(/Export as PNG/));

    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("listens only while it is open", () => {
    /*
     * Nothing observable happens on a press when the menu is closed — which is
     * the point: the effect returns early, so the board is not paying for a
     * capture-phase `pointerdown` handler on every stroke.
     */
    const { open } = show();

    fireEvent.pointerDown(document.body);
    open();

    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("takes its listeners with it when the board closes", () => {
    const { open, unmount } = show();
    open();

    unmount();

    expect(() => {
      fireEvent.pointerDown(document.body);
      fireEvent.keyDown(window, { key: "Escape" });
    }).not.toThrow();
  });
});
