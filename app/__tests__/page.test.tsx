// @vitest-environment jsdom
/**
 * `/` — the front door, which is the canvas.
 *
 * Opening the app draws immediately: no gallery, no account, no "new board" step,
 * with the last drawing restored from localStorage by the editor itself. Two
 * things about that are worth holding in place.
 *
 * The collaboration provider is mounted here with a `null` room. Nothing
 * collaborative happens on this page — the socket is only opened for a real room
 * id — but `Canvas` calls `useCollaboration()` unconditionally, so without a
 * provider above it the front page throws on its first render.
 *
 * And `?roomId=x` is redirected to `/board/x`. That was this app's share-link
 * format before boards had rows; the links are in people's chat histories, and
 * without the redirect they land on a canvas that looks fine and is shared with
 * nobody.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The editor and the socket provider are both tested in their own files. */
const canvas = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

/** `redirect()` throws in Next, and the page relies on it: the fake does too. */
const navigation = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect: navigation.redirect }));
vi.mock("../components/Canvas", () => ({
  default: (props: Record<string, unknown>) => {
    canvas.props.push(props);
    return <div data-testid="editor" />;
  },
}));
vi.mock("../context/CollaborationContext", () => ({
  CollaborationContextProvider: ({
    roomId,
    children,
  }: {
    roomId: string | null;
    children: React.ReactNode;
  }) => (
    <div data-testid="provider" data-room={String(roomId)}>
      {children}
    </div>
  ),
}));

import Home from "../page";

const openCanvas = async (search: { roomId?: string } = {}) => {
  render(await Home({ searchParams: Promise.resolve(search) }));
  return canvas.props.at(-1)!;
};

beforeEach(() => {
  canvas.props.length = 0;
  navigation.redirect.mockImplementation(() => {
    throw new Error("NEXT_REDIRECT");
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the canvas you land on", () => {
  it("is a local one, with no room and no socket", async () => {
    const props = await openCanvas();

    expect(props.isCollaborative).toBe(false);
    expect(props.initialTool).toBe("Select");
    expect(props.boardId).toBeUndefined();
    expect(screen.getByTestId("provider").dataset.room).toBe("null");
  });

  it("sits under the provider anyway, which is why it can render at all", async () => {
    // `Canvas` reads the collaboration context unconditionally; an unwrapped
    // front page throws on its first render.
    await openCanvas();

    expect(within(screen.getByTestId("provider")).getByTestId("editor")).toBeTruthy();
    expect(navigation.redirect).not.toHaveBeenCalled();
  });
});

describe("a legacy share link", () => {
  it("goes to the board of that name", async () => {
    // `?roomId=x` is the old format, still in people's chat histories.
    await expect(openCanvas({ roomId: "V1StGXR8_Z" })).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(navigation.redirect).toHaveBeenCalledWith("/board/V1StGXR8_Z");
  });

  it("never renders the local canvas on the way", async () => {
    // Drawing on a canvas that is about to be replaced, and is shared with
    // nobody, is the failure the redirect exists to prevent.
    await expect(openCanvas({ roomId: "b1" })).rejects.toThrow("NEXT_REDIRECT");

    expect(canvas.props).toEqual([]);
  });
});
