// @vitest-environment jsdom
/**
 * Other people's cursors, drawn over the canvas.
 *
 * Positions arrive in world coordinates, and the bug this layer was written to
 * fix was two earlier overlays disagreeing about that: one treated them as screen
 * coordinates, the other applied zoom but not scroll. Either way a cursor pointed
 * at a different part of the drawing for each person in the room, which is the
 * one thing a shared cursor cannot do — so the projection is asserted against the
 * same transform the renderer uses, at a zoom and a scroll that are both
 * non-trivial.
 *
 * The rest is identity: your own cursor must not be drawn (you already have one,
 * and it lags), and a person's colour has to stay theirs from one message to the
 * next or the room becomes impossible to follow.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import RemoteCursors from "../RemoteCursors";
import type { CursorPositionsMap } from "../../../types/collaboration";
import type { Viewport } from "../../../types/shapes";
import { worldToScreen } from "../../../utils/viewport";

const HERE: Viewport = { zoom: 1, scroll: { x: 0, y: 0 } };

const at = (x: number, y: number, tag?: string) => ({ x, y, tag });

const show = (
  cursors: CursorPositionsMap,
  { me = "me", viewport = HERE }: { me?: string | null; viewport?: Viewport } = {},
) => {
  const view = render(
    <RemoteCursors cursors={cursors} currentUserId={me} viewport={viewport} />,
  );

  /** One element per drawn cursor, in the order they were rendered. */
  const drawn = () =>
    Array.from(view.container.firstElementChild!.children) as HTMLElement[];

  return { ...view, drawn };
};

/** The `translate3d` a cursor was placed at, as numbers. */
const positionOf = (element: HTMLElement) => {
  const match = /translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\)/.exec(
    element.style.transform,
  );
  return { x: Number(match?.[1]), y: Number(match?.[2]) };
};

const arrowColorOf = (element: HTMLElement) =>
  element.querySelector("path")!.getAttribute("fill");

const labelOf = (element: HTMLElement) => element.querySelector("span");

/** jsdom reports colours back as `rgb()`, whatever they were written as. */
const hexToRgb = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
};

afterEach(cleanup);

describe("whose cursors are drawn", () => {
  it("leaves your own out of it", () => {
    /*
     * The server echoes your own cursor back with everyone else's. Drawing it
     * puts a second arrow on screen that trails the real pointer by a round trip
     * — and follows it even while the window is not focused.
     */
    const { drawn } = show({
      me: at(10, 10, "Ada"),
      peer: at(20, 20, "Grace"),
    });

    expect(drawn()).toHaveLength(1);
    expect(labelOf(drawn()[0])?.textContent).toBe("Grace");
  });

  it("draws everybody when there is no local identity yet", () => {
    // Before the socket has said who you are, `currentUserId` is null; that is
    // not a licence to hide the room.
    const { drawn } = show({ peer: at(20, 20, "Grace") }, { me: null });

    expect(drawn()).toHaveLength(1);
  });

  it("draws nothing in an empty room", () => {
    const { drawn } = show({});

    expect(drawn()).toHaveLength(0);
  });

  it("draws one per person, and keeps them apart", () => {
    const { drawn } = show({
      grace: at(20, 20, "Grace"),
      alan: at(40, 60, "Alan"),
    });

    expect(drawn().map(positionOf)).toEqual([
      { x: 20, y: 20 },
      { x: 40, y: 60 },
    ]);
  });
});

describe("where they land", () => {
  it("follows the viewport, not the raw coordinates", () => {
    /*
     * Zoom and scroll are both in play, and both were got wrong before: the
     * position has to be `(world + scroll) * zoom`, the same expression the
     * renderer applies to the elements underneath.
     */
    const viewport: Viewport = { zoom: 2, scroll: { x: -30, y: 15 } };
    const { drawn } = show({ grace: at(100, 40, "Grace") }, { viewport });

    expect(positionOf(drawn()[0])).toEqual(worldToScreen(100, 40, viewport));
    // Spelled out, so a wrong-but-consistent transform cannot pass:
    expect(positionOf(drawn()[0])).toEqual({ x: 140, y: 110 });
  });

  it("lets a cursor scrolled off the drawing go off the overlay", () => {
    // Clamping to the edge would pile everyone who is looking elsewhere into one
    // corner; the overlay hides the overflow instead.
    const { drawn, container } = show(
      { grace: at(-500, -500, "Grace") },
      { viewport: { zoom: 1, scroll: { x: 0, y: 0 } } },
    );

    expect(positionOf(drawn()[0])).toEqual({ x: -500, y: -500 });
    expect(container.firstElementChild!.className).toContain("overflow-hidden");
  });

  it("takes no clicks, being drawn over the drawing surface", () => {
    // The overlay covers the whole canvas. If it took pointer events, drawing
    // would stop working the moment somebody else joined.
    const { container } = show({ grace: at(20, 20, "Grace") });

    expect(container.firstElementChild!.className).toContain(
      "pointer-events-none",
    );
  });
});

describe("colour", () => {
  it("gives the same person the same colour every time", () => {
    // Cursors move constantly. A colour recomputed from anything but the id —
    // an index, a random seed — flickers on every message.
    const first = show({ grace: at(20, 20, "Grace") });
    const before = arrowColorOf(first.drawn()[0]);
    cleanup();

    const second = show({ grace: at(90, 90, "Grace") });

    expect(arrowColorOf(second.drawn()[0])).toBe(before);
  });

  it("does not depend on who else is in the room", () => {
    // Roster order changes as people come and go; a colour taken from position
    // in the list would reshuffle everyone's cursor each time.
    const alone = show({ grace: at(20, 20, "Grace") });
    const graceAlone = arrowColorOf(alone.drawn()[0]);
    cleanup();

    const crowd = show({
      alan: at(10, 10, "Alan"),
      ada: at(30, 30, "Ada"),
      grace: at(20, 20, "Grace"),
    });

    expect(arrowColorOf(crowd.drawn()[2])).toBe(graceAlone);
  });

  it("tells two people apart", () => {
    const { drawn } = show({
      grace: at(20, 20, "Grace"),
      alan: at(40, 40, "Alan"),
    });

    expect(arrowColorOf(drawn()[0])).not.toBe(arrowColorOf(drawn()[1]));
  });

  it("stays inside the palette whatever the id looks like", () => {
    /*
     * The hash is a signed 32-bit multiply-and-add, so it overflows to negative
     * for plenty of real ids; `Math.abs` before the modulo is what keeps the
     * index in range. Without it a cursor renders with `fill="undefined"` and
     * disappears — for some users only.
     */
    const ids = [
      "a",
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      "socket-9f8c2d1e-4b7a-4f3e-9c1d-2a5b6c7d8e9f",
      "…user with an unusual name 🎨",
      "",
    ];
    const { drawn } = show(
      Object.fromEntries(ids.map((id, index) => [id, at(index, index, id)])),
    );

    for (const cursor of drawn()) {
      expect(arrowColorOf(cursor)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("paints the label to match the arrow", () => {
    // The label is how you know whose arrow it is; two different colours read as
    // two different people.
    const { drawn } = show({ grace: at(20, 20, "Grace") });

    expect(labelOf(drawn()[0])!.style.backgroundColor).toBeTruthy();
    expect(labelOf(drawn()[0])!.style.backgroundColor).toBe(
      hexToRgb(arrowColorOf(drawn()[0])!),
    );
  });
});

describe("the label", () => {
  it("shows the name the roster gave", () => {
    const { drawn } = show({ grace: at(20, 20, "Grace Hopper") });

    expect(labelOf(drawn()[0])?.textContent).toBe("Grace Hopper");
  });

  it("is left off entirely when there is no name", () => {
    // An empty label is a coloured blob next to the arrow, which reads as a
    // rendering fault rather than as an unnamed guest.
    const { drawn } = show({ grace: at(20, 20) });

    expect(labelOf(drawn()[0])).toBeNull();
  });

  it("hides the arrow itself from screen readers", () => {
    // The arrow is decoration; the name is the information, and it is text.
    const { drawn } = show({ grace: at(20, 20, "Grace") });

    expect(drawn()[0].querySelector("svg")!.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});
