// @vitest-environment jsdom
/**
 * Board persistence is all cadence and departure: when the thumbnail is taken,
 * which transport carries the scene, and what still has to happen on the way
 * out. The picture itself is `services/canvas/__tests__/renderer.test.ts` — here
 * the renderer is a stub, because none of this cares what the JPEG looks like.
 */
import { useRef } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBoardPersistence } from "../useBoardPersistence";
import type { Shape, Viewport } from "../../../types/shapes";

/** Hoisted, because the factory below runs while the hook is being imported. */
const renderer = vi.hoisted(() => ({
  exportSceneToDataURL: vi.fn<(...args: unknown[]) => string | null>(),
}));

vi.mock("../../../services/canvas/renderer", () => renderer);

const shape = (id: string): Shape =>
  ({ id, tool: "Square", x: 0, y: 0, width: 10, height: 10 }) as unknown as Shape;

const viewport: Viewport = { zoom: 1, scroll: { x: 0, y: 0 } };

const BOARD = "abc1234567";

interface Props {
  boardId?: string;
  elements: Shape[];
  isConnected: boolean;
}

/** Mirrors how Canvas calls the hook: state plus a ref tracking it. */
const mount = (props: Props) =>
  renderHook(
    ({ boardId, elements, isConnected }: Props) => {
      const elementsRef = useRef<Shape[]>(elements);
      elementsRef.current = elements;
      const viewportRef = useRef<Viewport>(viewport);
      useBoardPersistence({
        boardId,
        elements,
        elementsRef,
        viewportRef,
        isConnected,
      });
    },
    { initialProps: props },
  );

let fetchMock: ReturnType<typeof vi.fn>;
let sendBeacon: ReturnType<typeof vi.fn>;

/** The requests aimed at one endpoint; `/open` fires on every mount. */
const callsTo = (fragment: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
};

const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const dispatch = (target: EventTarget, type: string) =>
  act(() => {
    target.dispatchEvent(new Event(type));
  });

beforeEach(() => {
  vi.useFakeTimers();
  renderer.exportSceneToDataURL.mockReset();
  renderer.exportSceneToDataURL.mockReturnValue("data:image/jpeg;base64,AAAA");
  fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
  vi.stubGlobal("fetch", fetchMock);
  sendBeacon = vi.fn(() => true);
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: sendBeacon,
  });
  setHidden(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("opening a board", () => {
  it("records the open", () => {
    mount({ boardId: BOARD, elements: [shape("a")], isConnected: true });

    expect(callsTo("/open")).toHaveLength(1);
  });

  it("does nothing at all without a board id", () => {
    const { unmount } = mount({ elements: [shape("a")], isConnected: false });

    tick(10_000);
    unmount();
    dispatch(window, "pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});

describe("thumbnail", () => {
  it("captures once edits have settled", () => {
    mount({ boardId: BOARD, elements: [shape("a")], isConnected: true });

    tick(3999);
    expect(callsTo("thumbnail")).toHaveLength(0);

    tick(1);
    expect(callsTo("thumbnail")).toHaveLength(1);
  });

  it("starts the wait again on every edit", () => {
    const { rerender } = mount({
      boardId: BOARD,
      elements: [shape("a")],
      isConnected: true,
    });

    tick(3000);
    rerender({
      boardId: BOARD,
      elements: [shape("a"), shape("b")],
      isConnected: true,
    });
    tick(3000);
    expect(callsTo("thumbnail")).toHaveLength(0);

    tick(1000);
    expect(callsTo("thumbnail")).toHaveLength(1);
  });

  it("takes the one it owes when the board is left", () => {
    // The gallery tile is what a quick edit-and-leave used to leave stale.
    const { rerender, unmount } = mount({
      boardId: BOARD,
      elements: [shape("a")],
      isConnected: true,
    });
    rerender({
      boardId: BOARD,
      elements: [shape("a"), shape("b")],
      isConnected: true,
    });
    tick(1000);

    unmount();

    expect(callsTo("thumbnail")).toHaveLength(1);
  });

  it("does not take a second one on the way out", () => {
    const { unmount } = mount({
      boardId: BOARD,
      elements: [shape("a")],
      isConnected: true,
    });

    tick(4000);
    unmount();

    expect(callsTo("thumbnail")).toHaveLength(1);
  });

  it("sends nothing for a scene with nothing in it", () => {
    renderer.exportSceneToDataURL.mockReturnValue(null);
    mount({ boardId: BOARD, elements: [], isConnected: true });

    tick(4000);

    expect(callsTo("thumbnail")).toHaveLength(0);
  });
});

/**
 * The scene reaches the database one of two ways: the socket server writes it
 * while connected, or this hook does when it is not. So every case here is an
 * offline one, and the question is only which transport can still get out.
 */
describe("flushing the scene", () => {
  const sceneInit = () => callsTo("/scene")[0][1] as RequestInit;

  it("writes it when the board is left by a route change", () => {
    const { unmount } = mount({
      boardId: BOARD,
      elements: [shape("a")],
      isConnected: false,
    });

    unmount();

    expect(callsTo("/scene")).toHaveLength(1);
    expect(sceneInit().method).toBe("PUT");
    expect(JSON.parse(String(sceneInit().body))).toMatchObject({
      scene: [{ id: "a" }],
      viewport,
    });
    // The page survives a route change, so there is no reason to accept the
    // 64KB ceiling that keepalive comes with.
    expect(sceneInit().keepalive).toBe(false);
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("leaves it to the server while the socket is connected", () => {
    const { unmount } = mount({
      boardId: BOARD,
      elements: [shape("a")],
      isConnected: true,
    });

    dispatch(window, "pagehide");
    unmount();

    expect(callsTo("/scene")).toHaveLength(0);
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("uses a beacon when the page itself is going away", () => {
    mount({ boardId: BOARD, elements: [shape("a")], isConnected: false });

    dispatch(window, "pagehide");

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(String(sendBeacon.mock.calls[0][0])).toContain(`/${BOARD}/scene`);
    expect(callsTo("/scene")).toHaveLength(0);
  });

  it("falls back to a keepalive request when the beacon is refused", () => {
    // What `sendBeacon` does when the payload is over the queue limit: it
    // answers false rather than throwing, which used to be discarded.
    sendBeacon.mockReturnValue(false);
    mount({ boardId: BOARD, elements: [shape("a")], isConnected: false });

    dispatch(window, "pagehide");

    expect(callsTo("/scene")).toHaveLength(1);
    expect(sceneInit().keepalive).toBe(true);
  });

  it("falls back when there is no beacon to use", () => {
    sendBeacon.mockImplementation(() => {
      throw new TypeError("sendBeacon is not a function");
    });
    mount({ boardId: BOARD, elements: [shape("a")], isConnected: false });

    dispatch(window, "pagehide");

    expect(callsTo("/scene")).toHaveLength(1);
  });

  it("sends an ordinary request when the tab is merely hidden", () => {
    mount({ boardId: BOARD, elements: [shape("a")], isConnected: false });

    setHidden(true);
    dispatch(document, "visibilitychange");

    expect(callsTo("/scene")).toHaveLength(1);
    expect(sceneInit().keepalive).toBe(false);
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("ignores becoming visible again", () => {
    mount({ boardId: BOARD, elements: [shape("a")], isConnected: false });

    dispatch(document, "visibilitychange");

    expect(callsTo("/scene")).toHaveLength(0);
  });
});
