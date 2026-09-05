// @vitest-environment jsdom
/**
 * Toasts: the app's only channel for "that worked" and "that did not".
 *
 * The hook owns a timer per toast, and every failure worth guarding lives in
 * that bookkeeping:
 *
 *  - A toast that never leaves sits over the canvas until the page is reloaded,
 *    so each kind's own duration is asserted rather than assumed shared — an
 *    error is meant to outlast a confirmation by seconds.
 *  - Reusing an id replaces a toast in place, which is how "Saving…" becomes
 *    "Saved". If the first toast's timer survives the replacement, the
 *    replacement disappears on a schedule it never asked for.
 *  - Timers outliving the component fire `setState` into a dead tree, which is a
 *    console error on every navigation away from a board mid-save.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ToastStack, { useToasts, type ToastApi } from "../Toast";

/** The live hook, so a test can post and dismiss the way a caller does. */
let api: ToastApi;

const Host: React.FC = () => {
  api = useToasts();
  return <ToastStack toasts={api.toasts} onDismiss={api.dismiss} />;
};

const mount = () => render(<Host />);

const show = (...args: Parameters<ToastApi["show"]>) => {
  let id = "";
  act(() => {
    id = api.show(...args);
  });
  return id;
};

const dismiss = (id: string) =>
  act(() => {
    api.dismiss(id);
  });

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

/** What is on screen, top to bottom. */
const messages = () =>
  Array.from(screen.getByRole("status").children).map(
    (row) => row.querySelector("span:nth-of-type(2)")?.textContent,
  );

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("posting", () => {
  it("puts the message on screen and answers with its id", () => {
    // The id is the handle a long action keeps so it can replace or drop its own
    // toast later; a caller that cannot address it has to leave it there.
    mount();

    const id = show("Board saved");

    expect(id).toBeTruthy();
    expect(messages()).toEqual(["Board saved"]);
  });

  it("gives every toast an id of its own", () => {
    // Two toasts sharing an id would collapse into one: the second would replace
    // the first instead of stacking under it.
    mount();

    const first = show("Copied link");
    const second = show("Board saved");

    expect(first).not.toBe(second);
    expect(messages()).toEqual(["Copied link", "Board saved"]);
  });

  it("stacks them in the order they happened", () => {
    // The newest goes at the bottom, nearest where the eye already is.
    mount();

    show("Connecting…");
    show("Connected");

    expect(messages()).toEqual(["Connecting…", "Connected"]);
  });
});

describe("how long they stay", () => {
  it("clears a confirmation after its own two-and-a-bit seconds", () => {
    mount();
    show("Board saved", { kind: "success" });

    advance(2199);
    expect(messages()).toEqual(["Board saved"]);

    advance(1);

    expect(messages()).toEqual([]);
  });

  it("keeps an error up long enough to read", () => {
    /*
     * An error is the one toast the user has to act on, and it is often the
     * longest sentence; the durations are per kind precisely so this one is not
     * gone before it has been read. If they were ever collapsed into a single
     * constant, this is the test that would notice.
     */
    mount();
    show("Could not reach the server", { kind: "error" });

    advance(2600);
    expect(messages()).toEqual(["Could not reach the server"]);

    advance(3400);

    expect(messages()).toEqual([]);
  });

  it("treats an unlabelled toast as information", () => {
    // `show("…")` with no options is the common call; it must not fall through
    // to a duration of zero and stay on screen for good.
    mount();
    show("Snapped to grid");

    advance(2600);

    expect(messages()).toEqual([]);
  });

  it("stays until dismissed when it is told to", () => {
    // How "Generating…" waits for the request that will replace it: no duration
    // can be right, because nobody knows how long the model will take.
    mount();
    const id = show("Generating…", { duration: 0 });

    advance(60_000);
    expect(messages()).toEqual(["Generating…"]);

    dismiss(id);

    expect(messages()).toEqual([]);
  });

  it("honours a duration the caller chose", () => {
    mount();
    show("Snapped to grid", { duration: 500 });

    advance(499);
    expect(messages()).toEqual(["Snapped to grid"]);

    advance(1);

    expect(messages()).toEqual([]);
  });
});

describe("replacing one in place", () => {
  it("swaps the message without stacking a second row", () => {
    // "Saving…" becoming "Saved" is one event to the user, and two rows would
    // read as two.
    mount();
    show("Saving…", { id: "save", duration: 0 });

    show("Saved", { id: "save", kind: "success" });

    expect(messages()).toEqual(["Saved"]);
  });

  it("drops the timer the old toast was on", () => {
    /*
     * The replacement carries its own duration. If the first toast's pending
     * timer is not cleared it still fires, dismissing a message that had barely
     * appeared — and the later timer then finds nothing to remove.
     */
    mount();
    show("Saving…", { id: "save", duration: 1000 });

    advance(900);
    show("Saved", { id: "save", duration: 1000 });
    advance(200);

    expect(messages()).toEqual(["Saved"]);

    advance(800);

    expect(messages()).toEqual([]);
  });

  it("leaves the other toasts where they are", () => {
    mount();
    show("Connected", { id: "socket", duration: 0 });
    show("Copied link");

    show("Reconnecting…", { id: "socket", duration: 0 });

    expect(messages()).toEqual(["Copied link", "Reconnecting…"]);
  });
});

describe("dismissing", () => {
  it("removes only the toast asked for", () => {
    mount();
    const first = show("Copied link", { duration: 0 });
    show("Board saved", { duration: 0 });

    dismiss(first);

    expect(messages()).toEqual(["Board saved"]);
  });

  it("stops the timer, so nothing fires for a toast already gone", () => {
    mount();
    const id = show("Copied link", { duration: 1000 });

    dismiss(id);
    const remaining = vi.getTimerCount();
    advance(1000);

    expect(remaining).toBe(0);
    expect(messages()).toEqual([]);
  });

  it("shrugs at an id it has never heard of", () => {
    // A caller that dismisses twice, or dismisses after the toast expired on its
    // own, is the normal case for a request that finishes late.
    mount();
    const id = show("Copied link");
    advance(2600);

    expect(() => dismiss(id)).not.toThrow();
    expect(messages()).toEqual([]);
  });

  it("can be dismissed from the toast itself", () => {
    // The X is the only way out of a `duration: 0` toast.
    mount();
    show("Generating…", { duration: 0 });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(messages()).toEqual([]);
  });

  it("dismisses the row whose button was pressed", () => {
    mount();
    show("Copied link", { duration: 0 });
    show("Board saved", { duration: 0 });

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);

    expect(messages()).toEqual(["Board saved"]);
  });
});

describe("leaving the page", () => {
  it("takes its pending timers with it", () => {
    // Navigating away mid-save unmounts the host. A timer that survives calls
    // `setState` on a tree that is gone.
    const { unmount } = mount();
    show("Saving…", { duration: 5000 });
    show("Copied link", { duration: 2600 });

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the stack itself", () => {
  it("announces its messages without stealing focus", () => {
    /*
     * A toast appears while the user is mid-drag; moving focus to it would
     * interrupt the drawing. `aria-live` is how the message is read out with
     * focus left where it was.
     */
    mount();
    show("Board saved");

    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(document.activeElement).toBe(document.body);
  });

  it("marks an error out from the rest", () => {
    // Colour on the border rather than the text, because the message itself has
    // to stay legible in both themes.
    mount();
    show("Could not reach the server", { kind: "error" });
    show("Board saved", { kind: "success" });

    const [error, success] = Array.from(screen.getByRole("status").children);
    expect((error as HTMLElement).style.borderColor).toBe("var(--danger)");
    expect((success as HTMLElement).style.borderColor).toBe(
      "var(--island-border)",
    );
  });

  it("hides the icon from screen readers, the message being the message", () => {
    mount();
    show("Board saved", { kind: "success" });

    const icon = screen.getByRole("status").querySelector("span");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("takes no pointer events except on the toasts themselves", () => {
    // The region covers the top of the canvas. If it swallowed clicks, drawing
    // near the top edge would stop working while a toast was up.
    mount();
    show("Board saved");

    const region = screen.getByRole("status");
    expect(region.className).toContain("pointer-events-none");
    expect((region.firstElementChild as HTMLElement).className).toContain(
      "pointer-events-auto",
    );
  });

  it("draws nothing when there is nothing to say", () => {
    mount();

    expect(screen.getByRole("status").children).toHaveLength(0);
  });
});
