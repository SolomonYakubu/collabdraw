// @vitest-environment jsdom
/**
 * The tool island.
 *
 * Presentational, and its interesting property is what it *leaves out*: every
 * document-level action is optional, because on the canvas they live in the
 * top-left menu instead (Excalidraw's split) and the island keeps to drawing,
 * undo/redo and collaboration. A toolbar handed none of them must render none of
 * them — a stray export button here would be a second, divergent way to do
 * something the menu already does.
 *
 * The rest is the state a button is in: which tool is pressed, whether the lock
 * is on, whether undo has anything to undo, and the three appearances of the
 * assistant button (idle, working, unread).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Toolbar, { type ToolbarProps } from "../Toolbar";
import { TOOL_SHORTCUTS } from "../../../../hooks/canvas/useKeyboardShortcuts";

/** Only what the canvas always passes; everything else is opt-in. */
const show = (overrides: Partial<ToolbarProps> = {}) => {
  const props: ToolbarProps = {
    tool: "Select",
    onToolChange: vi.fn(),
    toolLocked: false,
    onToggleToolLock: vi.fn(),
    canUndo: true,
    canRedo: true,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    ...overrides,
  };
  const view = render(<Toolbar {...props} />);
  return { ...view, props };
};

const button = (name: string | RegExp) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
const maybe = (name: string | RegExp) => screen.queryByRole("button", { name });
const toolButton = (label: string) => button(new RegExp(`^${label} —`));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the tools", () => {
  it("offers every tool the keyboard offers", () => {
    /*
     * The island and the shortcuts are generated from one list, so a tool added
     * to the keyboard cannot be missing from the toolbar — the two used to be
     * separate and drifted.
     */
    show();

    expect(screen.getAllByRole("button", { pressed: false }).length).toBe(
      TOOL_SHORTCUTS.length - 1,
    );
    for (const { label } of TOOL_SHORTCUTS) {
      expect(screen.getAllByRole("button", { name: new RegExp(`— ${label}$`) })).toHaveLength(1);
    }
  });

  it("names each tool for what it draws, with its key", () => {
    // "Square" is the internal name and "Rectangle" is what it draws; the key is
    // in the label because that is where the shortcuts are documented.
    show();

    expect(toolButton("Rectangle").getAttribute("title")).toBe("Rectangle — R");
    expect(toolButton("Ellipse").getAttribute("aria-label")).toBe("Ellipse — O");
    expect(toolButton("Hand \\(panning\\)")).toBeTruthy();
  });

  it("shows which one is in hand", () => {
    // `aria-pressed` as well as the tint: the active tool is the single most
    // important piece of state in the app.
    show({ tool: "Freehand" });

    expect(toolButton("Draw").getAttribute("aria-pressed")).toBe("true");
    expect(toolButton("Draw").getAttribute("data-active")).toBe("true");
    expect(toolButton("Selection").getAttribute("aria-pressed")).toBe("false");
    expect(toolButton("Selection").getAttribute("data-active")).toBeNull();
  });

  it("switches tool by its own name, not by its position", () => {
    // The handler is passed the tool id, so reordering the list cannot silently
    // rebind the buttons.
    const { props } = show();

    fireEvent.click(toolButton("Eraser"));

    expect(props.onToolChange).toHaveBeenCalledWith("Eraser");
  });
});

describe("the tool lock", () => {
  it("explains which way it is facing", () => {
    // An open or closed padlock is the only other cue, and it is easy to read
    // backwards; the tooltip says what will happen after the next shape.
    const { rerender, props } = show({ toolLocked: false });

    expect(button(/Back to selection after each shape/)).toBeTruthy();

    rerender(<Toolbar {...props} toolLocked />);

    expect(button(/Tool stays active after drawing/)).toBeTruthy();
  });

  it("marks itself while the lock is on", () => {
    show({ toolLocked: true });

    expect(button(/Tool stays active/).getAttribute("data-active")).toBe("true");
  });

  it("toggles when pressed", () => {
    const { props } = show();

    fireEvent.click(button(/Back to selection after each shape/));

    expect(props.onToggleToolLock).toHaveBeenCalledTimes(1);
  });
});

describe("undo and redo", () => {
  it("goes dim when there is nothing to undo or redo", () => {
    // The keyboard shortcut is a no-op at the ends of the history; the buttons
    // say so rather than appearing to do nothing.
    show({ canUndo: false, canRedo: false });

    expect(button(/^Undo/).disabled).toBe(true);
    expect(button(/^Redo/).disabled).toBe(true);
  });

  it("works, and teaches its shortcut", () => {
    const { props } = show();

    fireEvent.click(button(/^Undo/));
    fireEvent.click(button(/^Redo/));

    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(props.onRedo).toHaveBeenCalledTimes(1);
    expect(button(/^Undo/).getAttribute("title")).toBe("Undo — Ctrl+Z");
    expect(button(/^Redo/).getAttribute("title")).toBe("Redo — Ctrl+Shift+Z");
  });
});

describe("what it leaves out unless asked", () => {
  it("shows only drawing controls on the canvas", () => {
    /*
     * Export, reset, share and the theme all live in the top-left menu on the
     * canvas. Rendering them here as well would be two ways to do each, and they
     * would drift.
     */
    show();

    expect(maybe("Export as PNG")).toBeNull();
    expect(maybe("Reset the canvas")).toBeNull();
    expect(maybe(/Copy share link/)).toBeNull();
    expect(maybe("Collaborators")).toBeNull();
    expect(maybe("Assistant")).toBeNull();
    expect(maybe(/theme/)).toBeNull();
  });

  it("renders each one when it is handed the action for it", () => {
    // An embedded use — and the tests — pass them, and then they appear.
    const onExport = vi.fn();
    const onClear = vi.fn();
    show({ onExport, onClear, onShare: vi.fn(), users: [] });

    fireEvent.click(button("Export as PNG"));
    fireEvent.click(button("Reset the canvas"));

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(button("Collaborators")).toBeTruthy();
  });

  it("keeps the theme control off unless it also knows the current theme", () => {
    // The icon *is* the state — sun, moon or monitor — so without the preference
    // there is nothing to draw.
    show({ onCycleTheme: vi.fn() });

    expect(maybe(/theme/)).toBeNull();
  });

  it("groups the document actions behind a divider only when there are some", () => {
    // Otherwise the island ends on a divider with nothing after it.
    const { container } = show();
    const bare = container.querySelectorAll(".divider").length;
    cleanup();

    const withActions = show({ onClear: vi.fn() });

    expect(withActions.container.querySelectorAll(".divider").length).toBe(
      bare + 1,
    );
  });
});

describe("sharing", () => {
  it("offers to copy the link", () => {
    const { props } = show({ onShare: vi.fn() });

    fireEvent.click(button("Copy share link"));

    expect(props.onShare).toHaveBeenCalledTimes(1);
  });

  it("says what sharing means here, when the caller knows better", () => {
    // On a local canvas the same button starts a session rather than copying a
    // link to one that already exists.
    show({ onShare: vi.fn(), shareLabel: "Start a collaboration session" });

    expect(button("Start a collaboration session")).toBeTruthy();
  });

  it("confirms in place once the link is on the clipboard", () => {
    /*
     * A copy produces nothing visible — no dialog, no navigation — so the button
     * itself is the confirmation, and it holds the state for a couple of seconds.
     */
    show({ onShare: vi.fn(), shareLabel: "Copy share link", linkCopied: true });

    expect(button("Link copied").getAttribute("data-active")).toBe("true");
  });
});

describe("the assistant button", () => {
  it("shows whether the panel is open", () => {
    show({ onToggleAI: vi.fn(), isAIPanelOpen: true });

    expect(button("Assistant").getAttribute("aria-pressed")).toBe("true");
    expect(button("Assistant").getAttribute("data-active")).toBe("true");
  });

  it("toggles the panel", () => {
    const onToggleAI = vi.fn();
    show({ onToggleAI });

    fireEvent.click(button("Assistant"));

    expect(onToggleAI).toHaveBeenCalledTimes(1);
  });

  it("spins while a drawing is being generated", () => {
    // The panel may be closed while the model works — the request survives it —
    // so the island is where "still working" has to be visible.
    show({ onToggleAI: vi.fn(), isAiGenerating: true });

    expect(button("Assistant").querySelector(".animate-spin")).toBeTruthy();
  });

  it("marks unread replies when the panel is closed", () => {
    // A reply arriving behind a closed panel is otherwise invisible.
    show({ onToggleAI: vi.fn(), aiConversationCount: 2 });

    expect(button("Assistant").querySelector(".rounded-full")).toBeTruthy();
  });

  it("does not show the dot and the spinner at once", () => {
    // They occupy the same corner, and "working" already implies there is a
    // conversation.
    show({ onToggleAI: vi.fn(), aiConversationCount: 2, isAiGenerating: true });

    expect(
      button("Assistant").querySelectorAll(".rounded-full"),
    ).toHaveLength(1);
    expect(button("Assistant").querySelector(".animate-spin")).toBeTruthy();
  });

  it("shows nothing extra on a conversation that has not started", () => {
    show({ onToggleAI: vi.fn(), aiConversationCount: 0 });

    expect(button("Assistant").querySelector(".animate-spin")).toBeNull();
    expect(button("Assistant").querySelector(".rounded-full")).toBeNull();
  });
});

describe("the theme control", () => {
  it("says which theme is on and what pressing it will do", () => {
    /*
     * Three states, not two: "dark" and "following your system while the system
     * is dark" look identical, and the difference matters the next time the
     * system flips.
     */
    const { rerender, props } = show({
      onCycleTheme: vi.fn(),
      themePreference: "light",
    });

    expect(button("Light theme — click for dark")).toBeTruthy();

    rerender(<Toolbar {...props} themePreference="dark" />);
    expect(button("Dark theme — click to follow your system")).toBeTruthy();

    rerender(<Toolbar {...props} themePreference="system" />);
    expect(button("Matching your system — click for light")).toBeTruthy();
  });

  it("cycles when pressed", () => {
    const onCycleTheme = vi.fn();
    show({ onCycleTheme, themePreference: "dark" });

    fireEvent.click(button(/^Dark theme/));

    expect(onCycleTheme).toHaveBeenCalledTimes(1);
  });
});

describe("the collaborators", () => {
  it("hands the roster the room it was given", () => {
    // The list itself belongs to `CollaboratorsButton`; the toolbar's part is
    // passing the room through, count and all.
    show({
      users: [
        { id: "me", tag: "Ada" },
        { id: "peer", tag: "Grace" },
      ],
      currentUserId: "me",
      userName: "Ada",
      onRenameUser: vi.fn(() => true),
    });

    expect(button("Collaborators").textContent).toBe("2");
  });

  it("appears for an empty room too, since a room can be joined", () => {
    // `users: []` still means "this is a shared board"; the absence of the prop
    // is what means local.
    show({ users: [] });

    expect(button("Collaborators").textContent).toBe("");
  });
});
