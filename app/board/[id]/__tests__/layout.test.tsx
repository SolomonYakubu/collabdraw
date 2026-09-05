// @vitest-environment jsdom
/**
 * The editor layout — the one place the collaboration socket is opened.
 *
 * It is here rather than in the root layout on purpose: a provider above every
 * page would connect a socket for the gallery and for the local canvas at `/`,
 * neither of which has a room to join. Scoped to this segment, the connection
 * belongs to the board being edited and is torn down by navigating away from it.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../context/CollaborationContext", () => ({
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

import BoardLayout from "../layout";

const open = async (id: string) =>
  render(
    await BoardLayout({
      params: Promise.resolve({ id }),
      children: <div data-testid="editor" />,
    }),
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the room the socket joins", () => {
  it("is the board in the path, character for character", async () => {
    // The board id is also the room id, and it is a `nanoid(10)`: anything that
    // rewrote it — trimming, lower-casing — would put two people editing the same
    // link into two different rooms.
    await open("V1StGXR8_Z");

    expect(screen.getByTestId("provider").dataset.room).toBe("V1StGXR8_Z");
  });

  it("wraps the editor, so the canvas can read the context", async () => {
    await open("b1");

    expect(
      within(screen.getByTestId("provider")).getByTestId("editor"),
    ).toBeTruthy();
  });
});
