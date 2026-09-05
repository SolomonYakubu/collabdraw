// @vitest-environment jsdom
/**
 * The editor, as wiring.
 *
 * Every piece it assembles is tested on its own — the scene, the pointer
 * handling, the renderer, each panel. What is left here is the joins, and the
 * joins are where this component's bugs have been:
 *
 *  - **Which scene wins.** A board's scene comes from the server, the local
 *    canvas's from this browser, and `?adopt=local` is the one case where a board
 *    reads the browser's copy. Getting the precedence wrong blanks a drawing.
 *  - **What reaches the socket.** A local edit is broadcast, a remote one must
 *    not be echoed back, and a full-scene replacement is a different message from
 *    a handful of changed elements.
 *  - **The two handovers.** Starting a session and leaving one both pass a
 *    drawing through localStorage, so both have to cope with a refused write
 *    rather than navigating away from work that was never saved.
 *  - **What the menu offers.** The same slot is "Save to my boards" on `/` and
 *    "Rename board…" in a room, and only a room can be left.
 *
 * The renderer is faked: what elements are *painted* is the clearest read on the
 * scene the editor settled on, and the drawing itself is `renderer`'s own tests.
 * `next/navigation` and the collaboration context are faked because they are the
 * two edges this component talks to.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Canvas from "../Canvas";
import { createElement } from "../../services/canvas/elements";
import { LOCAL_SCENE_KEY, LOCAL_SCENE_VERSION, SAVE_DEBOUNCE_MS } from "../../services/canvas/localScene";
import { serializeScene } from "../../services/canvas/sceneFile";
import { STORAGE_SYNC_DEBOUNCE_MS } from "../../services/storageSync";
import { DEFAULT_STYLE, type Shape, type Viewport } from "../../types/shapes";

/** Navigation, and the collaboration edge, both replaced by recorders. */
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

let collab: CollaborationFake;
vi.mock("../../context/CollaborationContext", () => ({
  useCollaborationContext: () => collab,
}));

vi.mock("roughjs", () => ({ default: { canvas: () => ({}) } }));
vi.mock("../../services/canvas/renderer", () => ({
  renderStaticScene: vi.fn(),
  renderInteractiveScene: vi.fn(),
  exportSceneToDataURL: vi.fn(() => "data:image/png;base64,scene"),
  drawElement: vi.fn(),
}));

const { renderStaticScene } = await import("../../services/canvas/renderer");
const painter = vi.mocked(renderStaticScene);

type Handlers = Parameters<CollaborationFake["setEventHandlers"]>[0];

/** Only what `Canvas` reads off the context, with the sends recorded. */
interface CollaborationFake {
  isConnected: boolean;
  isEnabled: boolean;
  roomId: string | null;
  userId: string | null;
  users: Array<{ id: string; tag: string }>;
  cursors: Record<string, never>;
  remoteInProgress: Record<string, Shape>;
  scenePersistence: {
    durable: boolean | null;
    reason: "deleted" | "too-large" | "unreachable" | null;
  };
  userName: string;
  setUserName: (value: string) => boolean;
  shareableLink: string;
  linkCopied: boolean;
  copyShareableLink: () => Promise<boolean>;
  sendCursor: (point: unknown) => void;
  sendScene: (elements: Shape[]) => void;
  sendElements: (elements: Shape[]) => void;
  sendDeletions: (ids: string[]) => void;
  sendPendingElement: (element: Shape | null) => void;
  setEventHandlers: (handlers: {
    onScene?: (elements: Shape[]) => void;
    onInitialScene?: (elements: Shape[]) => void;
    onElements?: (elements: Shape[]) => void;
    onDeletions?: (ids: string[]) => void;
    getScene?: () => Shape[];
  }) => void;
}

/** The handlers the editor registered, so a test can play the socket. */
let socket: Handlers;
/** Whether the clipboard accepted the share link. */
let copyWorks: boolean;
interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[];
/** What `POST /api/boards` answers with. */
let saveResponse: { ok: boolean; payload: unknown };
/** Whether a rename is accepted. */
let renameOk: boolean;
/** Downloads: the object URLs made and revoked, and the anchors clicked. */
let objectUrls: string[];
let revoked: string[];
let clicked: Array<{ href: string; download: string }>;

const makeCollab = (): CollaborationFake => ({
  isConnected: true,
  isEnabled: true,
  roomId: "room-1",
  userId: "me",
  users: [{ id: "me", tag: "Ada" }],
  cursors: {},
  remoteInProgress: {},
  scenePersistence: { durable: null, reason: null },
  userName: "Ada",
  setUserName: vi.fn(() => true),
  shareableLink: "http://localhost/board/room-1",
  linkCopied: false,
  copyShareableLink: vi.fn(async () => copyWorks),
  sendCursor: vi.fn(),
  sendScene: vi.fn(),
  sendElements: vi.fn(),
  sendDeletions: vi.fn(),
  sendPendingElement: vi.fn(),
  setEventHandlers: vi.fn((handlers) => {
    socket = handlers;
  }),
});

const box = (id: string, x = 0, y = 0): Shape =>
  createElement("Square", { id, x, y, width: 40, height: 30 })!;

const AT_250 = { zoom: 2.5, scroll: { x: -40, y: 20 } } satisfies Viewport;

/** Seed the browser's copy of the scene, as a previous visit would have. */
const storeLocalScene = (elements: Shape[], viewport: Viewport | null = null) => {
  window.localStorage.setItem(
    LOCAL_SCENE_KEY,
    JSON.stringify({ version: LOCAL_SCENE_VERSION, elements, viewport }),
  );
};

/**
 * Make every `localStorage` write fail, as a full quota does. Returns the spy, so
 * a test can let storage recover.
 *
 * On `Storage.prototype`, not on `window.localStorage`: jsdom's storage is a
 * proxy that treats a property write as a stored *key*, so spying on the
 * instance quietly stores a "setItem" entry and leaves the real method in place.
 */
const fillStorage = () =>
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("QuotaExceededError");
  });

beforeEach(() => {
  collab = makeCollab();
  socket = {};
  copyWorks = true;
  calls = [];
  saveResponse = { ok: true, payload: { id: "new-board" } };
  renameOk = true;
  objectUrls = [];
  revoked = [];
  clicked = [];
  push.mockClear();
  painter.mockClear();

  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  // The surface paints inside a frame; running them as they are asked for keeps
  // "what is on the canvas" readable straight after an action.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

  /*
   * jsdom implements no pointer capture, and the surface takes it on every press
   * — unguarded, because a browser always has it. Defined rather than stubbed so
   * a jsdom that grows the API keeps its own.
   */
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      if (url === "/api/boards") {
        return {
          ok: saveResponse.ok,
          status: saveResponse.ok ? 201 : 500,
          json: async () => {
            if (saveResponse.payload === "not-json") {
              throw new SyntaxError("Unexpected token < in JSON");
            }
            return saveResponse.payload;
          },
        } as Response;
      }
      return { ok: renameOk, status: renameOk ? 200 : 500 } as Response;
    }),
  );

  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:${objectUrls.length}`;
    objectUrls.push(url);
    void blob;
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.documentElement.removeAttribute("data-theme");
});

type CanvasProps = Parameters<typeof Canvas>[0];

/** The local canvas at `/`: no board, no room. */
const LOCAL = { isCollaborative: false } satisfies Partial<CanvasProps>;
/** A saved board in a room, which is what `/board/[id]` renders. */
const BOARD = { boardId: "b1", initialTitle: "Sprint plan" } satisfies Partial<CanvasProps>;

const open = (props: Partial<CanvasProps> = {}) => {
  const view = render(<Canvas {...props} />);
  const update = (next: Partial<CanvasProps>) => {
    Object.assign(props, next);
    view.rerender(<Canvas {...props} />);
  };
  return { ...view, update };
};

/** Let the effects and any awaited request settle. */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** Wait out a real timer — the autosave debounce is the only one that matters. */
const tick = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

/**
 * What the surface last painted. The renderer is faked, so this is the scene the
 * editor decided on — including elements restored from storage or a file, which
 * have no other readout on a canvas.
 */
const painted = (): Shape[] => {
  const last = painter.mock.calls.at(-1)?.[0] as { elements?: Shape[] } | undefined;
  return last?.elements ?? [];
};
const paintedIds = () => painted().map((element) => element.id);

const button = (name: string | RegExp) => screen.getByRole("button", { name });
/**
 * jsdom applies no media queries, so the desktop islands and the phone bar are
 * both in the tree and share several labels. The desktop main menu is the one
 * called "Main menu"; the drawer's trigger is "Open main menu".
 */
const openMenu = () => fireEvent.click(button("Main menu"));
const item = (label: string | RegExp) =>
  screen.getByRole("menuitem", { name: label }) as HTMLButtonElement;
const choose = (label: string | RegExp) => {
  openMenu();
  fireEvent.click(item(label));
};
const dialog = () => screen.getByRole("dialog");
const inDialog = (name: string | RegExp) =>
  within(dialog()).getByRole("button", { name });
const toasts = () => screen.getByRole("status").textContent ?? "";
const zoomReadout = () => button("Reset zoom").textContent;
const canvases = () =>
  Array.from(document.querySelectorAll("canvas")) as HTMLCanvasElement[];
/** The upper canvas, which is the one carrying the pointer handlers. */
const surface = () => canvases()[1];
/** Select everything, the way Ctrl+A does — the pointer is not the subject here. */
const selectAll = () => fireEvent.keyDown(window, { key: "a", ctrlKey: true });
/** A `StylePanel` section, since its labels repeat across sections. */
const section = (title: string) => screen.getByText(title).parentElement as HTMLElement;
const inSection = (title: string, name: string) =>
  within(section(title)).getByRole("button", { name });
/** Both bars carry an undo button; either being live means there is history. */
const canUndo = () =>
  screen
    .getAllByRole("button", { name: /^Undo/ })
    .some((element) => !(element as HTMLButtonElement).disabled);
/** Take a tool by its keyboard shortcut; the toolbar's buttons are its own test. */
const pickTool = (key: string) => fireEvent.keyDown(window, { key });
/**
 * The right-click menu. Only one menu is ever open — the main menu closes on
 * select — so the open `menu` is this one.
 */
const rightClickMenu = () => screen.queryByRole("menu");
const onCanvas = (name: RegExp) =>
  within(screen.getByRole("menu")).getByRole("menuitem", {
    name,
  }) as HTMLButtonElement;
/** The hidden file input behind "Open…". */
const filePicker = () =>
  document.querySelector<HTMLInputElement>('input[type="file"]')!;
const pickFile = async (name: string, text: string) => {
  const file = new File([text], name, { type: "application/json" });
  // jsdom's `Blob` implements none of the reading methods, and the editor opens a
  // document with `file.text()`.
  Object.defineProperty(file, "text", { value: async () => text });
  await act(async () => {
    fireEvent.change(filePicker(), { target: { files: [file] } });
  });
};

describe("the scene it opens with", () => {
  it("paints the drawing this browser saved, on the local canvas", () => {
    /*
     * Read synchronously in the state initializer rather than from an effect: an
     * effect paints one empty frame first, and a saved drawing appearing a beat
     * after the page does looks like a glitch.
     */
    storeLocalScene([box("stored")]);

    open(LOCAL);

    expect(paintedIds()).toEqual(["stored"]);
  });

  it("prefers what the server sent, on a board", () => {
    // The board's scene is authoritative; the stored one is the solo drawing this
    // browser happened to have and would blank a shared board.
    storeLocalScene([box("stored")]);

    open({ ...BOARD, initialElements: [box("from-server")] });

    expect(paintedIds()).toEqual(["from-server"]);
  });

  it("does not read this browser's copy for a board at all, even an empty one", () => {
    /*
     * A board with no elements yet is still the authority on its own scene — two
     * people opening it would otherwise each inject whatever their own browser
     * had lying around from the local canvas.
     */
    storeLocalScene([box("stored")]);

    open({ ...BOARD, initialElements: [] });

    expect(paintedIds()).toEqual([]);
  });

  it("refuses the handover when the room already holds a drawing", () => {
    // `?adopt=local` survives a reload of a room that has since been drawn in;
    // the room's own scene has to win, or the handover would overwrite it.
    storeLocalScene([box("stored")]);

    open({ ...BOARD, initialElements: [box("in-the-room")], adoptLocalScene: true });

    expect(paintedIds()).toEqual(["in-the-room"]);
  });

  it("leaves the stored drawing alone for a board that did not ask for it", () => {
    storeLocalScene([box("stored")]);

    open(BOARD);

    expect(paintedIds()).toEqual([]);
  });

  it("carries the drawing into a room started from the local canvas", () => {
    // `?adopt=local` is the handover: the drawing was flushed to storage on the
    // way out of `/`, and this is the room reading it back.
    storeLocalScene([box("handed-over")]);

    open({ ...BOARD, initialElements: [], adoptLocalScene: true });

    expect(paintedIds()).toEqual(["handed-over"]);
  });

  it("restores the pan and zoom the drawing was left at", () => {
    /*
     * In a layout effect, not the initializer: the zoom is *text* in the readout,
     * so seeding it from storage rendered "250%" against the server's "100%" and
     * React threw the hydrated tree away.
     */
    storeLocalScene([box("stored")], AT_250);

    open(LOCAL);

    expect(zoomReadout()).toBe("250%");
  });

  it("keeps the viewport the server sent instead", () => {
    storeLocalScene([box("stored")], AT_250);

    open({ ...BOARD, initialViewport: { zoom: 1, scroll: { x: 0, y: 0 } } });

    expect(zoomReadout()).toBe("100%");
  });

  it("starts at 1:1 with nothing stored", () => {
    open(LOCAL);

    expect(zoomReadout()).toBe("100%");
    expect(paintedIds()).toEqual([]);
  });
});

describe("the one-shot adopt instruction", () => {
  it("drops itself from the address bar", () => {
    /*
     * Reloading the room would otherwise re-inject a local scene the room has
     * since moved past — and the URL you copy to share should be the plain link.
     */
    window.history.replaceState(null, "", "/board/b1?adopt=local");
    storeLocalScene([box("handed-over")]);

    open({ ...BOARD, adoptLocalScene: true });

    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/board/b1");
  });

  it("keeps the rest of the query string", () => {
    window.history.replaceState(null, "", "/board/b1?adopt=local&debug=1");

    open({ ...BOARD, adoptLocalScene: true });

    expect(window.location.search).toBe("?debug=1");
  });

  it("leaves the address bar alone when there is nothing to drop", () => {
    window.history.replaceState(null, "", "/board/b1?debug=1");

    open(BOARD);

    expect(window.location.search).toBe("?debug=1");
  });
});

describe("what it puts on the wire", () => {
  it("sends the whole scene when the whole scene changed", async () => {
    // Emptying the canvas cannot be expressed as "these elements changed", so it
    // goes as a full scene — the peers' own histories reset off the back of it.
    open({ ...BOARD, initialElements: [box("a"), box("b", 80)] });

    choose(/^Reset the canvas/);
    fireEvent.click(inDialog("Reset"));
    await settle();

    expect(collab.sendScene).toHaveBeenCalledWith([]);
  });

  it("sends only the elements that changed", () => {
    /*
     * Restyling one shape used to go out as a full scene, which every peer then
     * answered with one of their own — the update storm this split fixed.
     */
    open({ ...BOARD, initialElements: [box("a"), box("b", 80)] });
    selectAll();

    fireEvent.click(inSection("Stroke", "#e03131"));

    expect(collab.sendScene).not.toHaveBeenCalled();
    const [sent] = vi.mocked(collab.sendElements).mock.calls.at(-1)!;
    expect(sent.map((element) => element.id)).toEqual(["a", "b"]);
    expect(sent[0].stroke).toBe("#e03131");
  });

  it("sends deletions as deletions", () => {
    // An element that is gone cannot be described by sending it; a peer that only
    // ever merged elements would keep the deleted one forever.
    open({ ...BOARD, initialElements: [box("a")] });
    selectAll();

    fireEvent.click(inSection("Actions", "Delete"));

    expect(collab.sendDeletions).toHaveBeenCalledWith(["a"]);
  });

  it("says nothing at all on a canvas that is not shared", async () => {
    // There is no socket on `/`, and the sends are no-ops there — but they are
    // skipped rather than called, since each one would serialise the scene.
    open({ ...LOCAL, initialElements: [box("a")] });
    selectAll();

    fireEvent.click(inSection("Stroke", "#e03131"));
    fireEvent.click(inSection("Actions", "Delete"));
    await settle();

    expect(collab.sendElements).not.toHaveBeenCalled();
    expect(collab.sendDeletions).not.toHaveBeenCalled();
    expect(collab.sendScene).not.toHaveBeenCalled();
  });

  it("registers no handlers on a canvas that is not shared", () => {
    open(LOCAL);

    expect(collab.setEventHandlers).not.toHaveBeenCalled();
  });
});

describe("what it does with what the socket says", () => {
  it("adopts a full scene, and makes it the point history starts from", () => {
    /*
     * A peer's undo arrives as a whole scene. Committing it to our own history
     * instead would make Ctrl+Z here walk back through their edits — and when
     * this reset was driven by an effect watching `elements`, it also fired on the
     * first shape *this* user drew, making that shape impossible to undo.
     */
    open({ ...BOARD, initialElements: [box("a")] });

    act(() => socket.onScene!([box("theirs")]));

    expect(paintedIds()).toEqual(["theirs"]);
    expect(canUndo()).toBe(false);
  });

  it("pushes our scene up when the room hydrates empty", () => {
    // The server has no cached scene for a board that was just opened from the
    // database; accepting its empty hydration would blank the board for everyone.
    open({ ...BOARD, initialElements: [box("from-db")] });

    act(() => socket.onInitialScene!([]));

    expect(paintedIds()).toEqual(["from-db"]);
    const [pushed] = vi.mocked(collab.sendScene).mock.calls.at(-1)!;
    expect(pushed.map((element) => element.id)).toEqual(["from-db"]);
  });

  it("takes the room's scene when the room has one", () => {
    open({ ...BOARD, initialElements: [box("from-db")] });

    act(() => socket.onInitialScene!([box("from-room")]));

    expect(paintedIds()).toEqual(["from-room"]);
    expect(collab.sendScene).not.toHaveBeenCalled();
  });

  it("merges a peer's elements without echoing them back", () => {
    /*
     * A remote edit is authoritative for the elements it names. Broadcasting the
     * result would bounce it straight back to the sender, and two peers drawing at
     * once would keep each other busy indefinitely.
     */
    open({ ...BOARD, initialElements: [box("a"), box("b", 80)] });
    const theirB = { ...(box("b", 200) as Shape) };

    act(() => socket.onElements!([theirB, box("c", 300)]));

    expect(paintedIds()).toEqual(["a", "b", "c"]);
    expect(painted().find((element) => element.id === "b")!.x).toBe(200);
    expect(collab.sendElements).not.toHaveBeenCalled();
    expect(collab.sendScene).not.toHaveBeenCalled();
  });

  it("removes what a peer deleted, and forgets it was selected", () => {
    // A selection naming a deleted element leaves handles floating over nothing,
    // and the next nudge would resurrect it.
    open({ ...BOARD, initialElements: [box("a"), box("b", 80)] });
    selectAll();

    act(() => socket.onDeletions!(["a"]));

    expect(paintedIds()).toEqual(["b"]);
    expect(screen.getByText("Actions")).toBeTruthy();

    act(() => socket.onDeletions!(["b"]));

    expect(screen.queryByText("Actions")).toBeNull();
  });

  it("hands a peer that asks the scene as it is now", () => {
    // Not the scene as it was when the handlers were registered: a peer joining
    // an hour in would be sent an hour-old drawing.
    open({ ...BOARD, initialElements: [box("a")] });
    act(() => socket.onElements!([box("later", 400)]));

    expect(socket.getScene!().map((element) => element.id)).toEqual(["a", "later"]);
  });

  it("paints the stroke a peer is still drawing, on top of the scene", () => {
    /*
     * An in-flight stroke is held apart from the scene — it belongs to nobody's
     * undo history and must not be saved — but it still has to be on screen, or a
     * peer drawing a long line looks like nothing is happening until they finish.
     */
    collab.remoteInProgress = { peer: box("theirs", 200) };

    open({ ...BOARD, initialElements: [box("mine")] });

    expect(paintedIds()).toEqual(["mine", "theirs"]);
  });

  it("paints it once, not twice, when the finished element lands", () => {
    // The pending copy and the committed one share an id, and a shape drawn twice
    // in one frame is visibly heavier than its neighbours.
    collab.remoteInProgress = { peer: box("theirs") };
    open(BOARD);
    expect(paintedIds()).toEqual(["theirs"]);

    act(() => socket.onElements!([box("theirs")]));

    expect(paintedIds()).toEqual(["theirs"]);
  });
});

describe("what the menu offers", () => {
  it("offers to save the local canvas to your boards", () => {
    open(LOCAL);
    openMenu();

    expect(item(/^Save to my boards/)).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /^Rename board/ })).toBeNull();
  });

  it("offers the board's name instead, once it is saved", () => {
    // The one document action still worth having in a room: the board is already
    // saved, and its name is what the gallery shows.
    open(BOARD);
    openMenu();

    expect(item(/^Rename board/).textContent).toContain("Saved");
    expect(screen.queryByRole("menuitem", { name: /^Save to my boards/ })).toBeNull();
  });

  it("offers a way out of a room, and none out of a canvas", () => {
    // The back button and the gallery link leave a room too, but neither is an
    // answer to "I am done here" — and neither offers to keep a copy.
    open(BOARD);
    openMenu();
    expect(item(/^Leave the room/)).toBeTruthy();
    cleanup();

    open(LOCAL);
    openMenu();

    expect(screen.queryByRole("menuitem", { name: /^Leave the room/ })).toBeNull();
  });

  it("starts a session from a canvas and copies the link from a room", () => {
    // One slot, two meanings: there is no link until there is a room.
    open(LOCAL);
    openMenu();
    expect(item(/^Live collaboration/)).toBeTruthy();
    cleanup();

    open(BOARD);
    openMenu();

    expect(item(/^Copy collaboration link/)).toBeTruthy();
  });

  it("says the link is copied where the action is", () => {
    collab.linkCopied = true;
    open(BOARD);
    openMenu();

    expect(item(/^Copy collaboration link/).textContent).toContain("Copied");
  });

  it("shows your name beside the item that changes it", () => {
    open(BOARD);
    openMenu();

    expect(item(/^Your name/).textContent).toContain("Ada");
  });

  it("says which theme is on, and which way the lock is facing", () => {
    // The lock starts on: snapping back to selection after every shape is a
    // surprise when you are drawing several of the same thing.
    open(LOCAL);
    openMenu();

    expect(item(/^Theme/).textContent).toContain("System");
    expect(item(/^Keep selected tool active/).textContent).toContain("On");
  });

  it("cycles the theme in place, the menu closing behind it", () => {
    open(LOCAL);

    choose(/^Theme/);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.queryByRole("menu")).toBeNull();

    openMenu();
    expect(item(/^Theme/).textContent).toContain("Light");
  });

  it("inverts the drawing in the dark, and the text being typed with it", () => {
    /*
     * Dark mode inverts the element layer rather than re-rendering it, so the
     * textarea over it has to carry the same filter — otherwise the text jumps
     * colour the moment editing starts, and back again when it ends.
     */
    open(LOCAL);

    choose(/^Theme/);
    choose(/^Theme/);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(canvases()[0].style.filter).toContain("invert");

    pickTool("t");
    fireEvent.pointerDown(surface(), {
      clientX: 40,
      clientY: 40,
      button: 0,
      pointerId: 1,
    });

    expect(document.querySelector("textarea")!.style.filter).toBe(
      canvases()[0].style.filter,
    );
  });

  it("is one preference behind the padlock and the menu item", () => {
    // Two controls and a keyboard shortcut for one setting: the toolbar's padlock
    // is easy to read backwards, and the menu spells out which state it is in.
    open(LOCAL);

    fireEvent.click(button(/Tool stays active after drawing/));
    openMenu();

    expect(item(/^Keep selected tool active/).textContent).toContain("Off");
    expect(
      button(/Back to selection after each shape/).getAttribute("data-active"),
    ).toBeNull();

    fireEvent.click(item(/^Keep selected tool active/));
    openMenu();

    expect(item(/^Keep selected tool active/).textContent).toContain("On");
    expect(
      button(/Tool stays active after drawing/).getAttribute("data-active"),
    ).toBe("true");
  });

  it("leads to the gallery, from a room as well as from the canvas", () => {
    // The only link to the rest of the app from a full-screen canvas.
    open(BOARD);

    choose(/^My boards/);

    expect(push).toHaveBeenCalledWith("/boards");
  });

  it("is the same menu in a drawer on a phone", () => {
    /*
     * One definition of "what is in the menu", rendered by `MainMenuList` in the
     * drawer and in the desktop popover. Two lists would drift — and this one is
     * built per board, so a room's items are the ones that would go missing.
     */
    open(BOARD);

    fireEvent.click(button("Open main menu"));

    expect(item(/^Rename board/)).toBeTruthy();
    expect(item(/^Leave the room/)).toBeTruthy();

    fireEvent.click(button("Close menu"));

    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});

describe("saving to your boards", () => {
  it("creates the board with its drawing in one request", async () => {
    /*
     * Board *and* scene together: creating an empty board and then saving into it
     * leaves a window where a refused second request loses the drawing, and
     * `/board/<id>` reads the scene straight from the database on arrival.
     */
    storeLocalScene([box("a")], AT_250);
    open(LOCAL);

    choose(/^Save to my boards/);
    await settle();

    const [request] = calls.filter((call) => call.url === "/api/boards");
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toEqual({
      title: "Untitled board",
      scene: [expect.objectContaining({ id: "a" })],
      viewport: AT_250,
    });
  });

  it("goes to the board it just made", async () => {
    open(LOCAL);

    choose(/^Save to my boards/);
    await settle();

    expect(toasts()).toContain("Saved to your boards");
    expect(push).toHaveBeenCalledWith("/board/new-board");
  });

  it("says it is working, the request being the slow kind", () => {
    // A click that produces nothing for a second looks like a click that missed.
    open(LOCAL);

    choose(/^Save to my boards/);

    expect(toasts()).toContain("Saving…");
  });

  it("passes the server's reason through", async () => {
    // "Could not save" is no help when the answer was "this drawing is too large";
    // the API says why and the toast repeats it.
    saveResponse = { ok: false, payload: { error: "That drawing is too large." } };
    open(LOCAL);

    choose(/^Save to my boards/);
    await settle();

    expect(toasts()).toContain("That drawing is too large.");
    expect(push).not.toHaveBeenCalled();
  });

  it("falls back to the status when the failure says nothing", async () => {
    // A 502 from a proxy is not JSON at all, and `json()` throwing must not
    // replace the failure with a crash.
    saveResponse = { ok: false, payload: "not-json" };
    open(LOCAL);

    choose(/^Save to my boards/);
    await settle();

    expect(toasts()).toContain("Save failed (500)");
  });
});

describe("starting a live session", () => {
  it("hands the drawing over through this browser and opens a room for it", () => {
    /*
     * The room adopts what is in storage on arrival, so the flush *is* the
     * handover — there is no request in between to carry the scene.
     */
    open({ ...LOCAL, initialElements: [box("a")] });

    choose(/^Live collaboration/);

    const stored = JSON.parse(window.localStorage.getItem(LOCAL_SCENE_KEY)!);
    expect(stored.elements.map((element: Shape) => element.id)).toEqual(["a"]);
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/board\/.{10}\?adopt=local$/));
  });

  it("stays put when the handover cannot be written", () => {
    /*
     * A refused write with the navigation still going ahead opens an empty room
     * and strands the drawing behind it — on a page that has already been left.
     */
    open({ ...LOCAL, initialElements: [box("a")] });
    fillStorage();

    choose(/^Live collaboration/);

    expect(push).not.toHaveBeenCalled();
    expect(toasts()).toContain("Could not start a session");
    expect(toasts()).toContain("Save it to a file first.");
    expect(paintedIds()).toEqual(["a"]);
  });
});

describe("leaving a room", () => {
  it("asks, because both drawings are somebody's work", () => {
    /*
     * The room's drawing and the one this browser saved before the room existed.
     * Excalidraw writes the room's over the local one with no prompt, which loses
     * the other instead (excalidraw#909).
     */
    open(BOARD);

    choose(/^Leave the room/);

    expect(dialog().textContent).toContain("Leave this room?");
    expect(dialog().textContent).toContain("the saved drawing is the one from before you shared");
    expect(inDialog("Keep a copy")).toBeTruthy();
    expect(inDialog("Leave without keeping")).toBeTruthy();
    expect(inDialog("Stay")).toBeTruthy();
  });

  it("does not promise the board is keeping anything while it is not", () => {
    // The server has just said it cannot save this room; "the room keeps this
    // drawing" would be a lie, and the copy may be the only survivor.
    collab.scenePersistence = { durable: false, reason: "unreachable" };
    open(BOARD);

    choose(/^Leave the room/);

    expect(dialog().textContent).toContain("may be the only one that survives");
  });

  it("writes the copy before it goes", () => {
    open({ ...BOARD, initialElements: [box("drawn-here")] });

    choose(/^Leave the room/);
    fireEvent.click(inDialog("Keep a copy"));

    const stored = JSON.parse(window.localStorage.getItem(LOCAL_SCENE_KEY)!);
    expect(stored.elements.map((element: Shape) => element.id)).toEqual(["drawn-here"]);
    expect(push).toHaveBeenCalledWith("/");
  });

  it("leaves the stored drawing alone when asked to", () => {
    // The other honest answer: the drawing from before you shared is the one
    // being kept, and the room's own copy stays in the room.
    storeLocalScene([box("from-before")]);
    open({ ...BOARD, initialElements: [box("drawn-here")] });

    choose(/^Leave the room/);
    fireEvent.click(inDialog("Leave without keeping"));

    const stored = JSON.parse(window.localStorage.getItem(LOCAL_SCENE_KEY)!);
    expect(stored.elements.map((element: Shape) => element.id)).toEqual(["from-before"]);
    expect(push).toHaveBeenCalledWith("/");
  });

  it("stays in the room when the copy cannot be written", () => {
    // Staying is recoverable; leaving with the copy silently unwritten is not, so
    // the warning has no timeout.
    open({ ...BOARD, initialElements: [box("drawn-here")] });
    fillStorage();

    choose(/^Leave the room/);
    fireEvent.click(inDialog("Keep a copy"));

    expect(push).not.toHaveBeenCalled();
    expect(toasts()).toContain("Could not keep a copy");
  });

  it("stays put on Stay", () => {
    open(BOARD);

    choose(/^Leave the room/);
    fireEvent.click(inDialog("Stay"));

    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("renaming the board", () => {
  it("asks with the name it has, and saves the new one", async () => {
    // A name matters in the gallery, not while drawing, which is why it is a menu
    // action rather than a field parked on the canvas.
    open(BOARD);

    choose(/^Rename board/);
    expect(within(dialog()).getByRole("textbox")).toHaveProperty("value", "Sprint plan");
    fireEvent.change(within(dialog()).getByRole("textbox"), {
      target: { value: "Q3 roadmap" },
    });
    fireEvent.click(inDialog("Rename"));
    await settle();

    expect(calls).toContainEqual({
      url: "/api/boards/b1",
      method: "PATCH",
      body: JSON.stringify({ title: "Q3 roadmap" }),
    });
    expect(toasts()).toContain("Board renamed");
  });

  it("keeps the new name on screen when the save fails", async () => {
    /*
     * Best effort by design: the name is cosmetic and the drawing is not, so a
     * failed PATCH says so rather than snapping the title back mid-session.
     */
    renameOk = false;
    open(BOARD);

    choose(/^Rename board/);
    fireEvent.change(within(dialog()).getByRole("textbox"), {
      target: { value: "Q3 roadmap" },
    });
    fireEvent.click(inDialog("Rename"));
    await settle();

    expect(toasts()).toContain("Renamed here, but the change was not saved.");
  });

  it("asks nothing of the server for the name it already has", async () => {
    open(BOARD);

    choose(/^Rename board/);
    fireEvent.click(inDialog("Rename"));
    await settle();

    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
  });

  it("does nothing on cancel", async () => {
    open(BOARD);

    choose(/^Rename board/);
    fireEvent.click(inDialog("Cancel"));
    await settle();

    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("your own name", () => {
  it("offers it whether or not there is a room to announce it to", () => {
    // It is stored in this browser, so it is also the name the next session you
    // start will carry.
    open(LOCAL);

    choose(/^Your name/);

    expect(dialog().textContent).toContain("Your name");
    expect(dialog().textContent).toContain("Stored in this browser");
  });

  it("saves it", () => {
    open(BOARD);

    choose(/^Your name/);
    fireEvent.change(within(dialog()).getByRole("textbox"), {
      target: { value: "Grace" },
    });
    fireEvent.click(inDialog("Save"));

    expect(collab.setUserName).toHaveBeenCalledWith("Grace");
    expect(toasts()).toContain("Name updated");
  });

  it("will not offer to save a name that is only whitespace", () => {
    // The dialog holds the first line: a label that renders as an empty box over
    // a cursor never reaches the store at all.
    open(BOARD);

    choose(/^Your name/);
    fireEvent.change(within(dialog()).getByRole("textbox"), {
      target: { value: "   " },
    });

    expect((inDialog("Save") as HTMLButtonElement).disabled).toBe(true);
    expect(collab.setUserName).not.toHaveBeenCalled();
  });

  it("keeps the old one when the store refuses the new one", () => {
    // Behind that disabled button: the context normalises and persists the name,
    // and a refusal there has to leave the old one standing rather than report a
    // rename that did not happen.
    collab.setUserName = vi.fn(() => false);
    open(BOARD);

    choose(/^Your name/);
    fireEvent.change(within(dialog()).getByRole("textbox"), {
      target: { value: "Grace" },
    });
    fireEvent.click(inDialog("Save"));

    expect(toasts()).toContain("keeping the old one");
  });

  it("does nothing on cancel, typed name and all", () => {
    // The field is prefilled and editable, so a dismissed dialog has a new name
    // sitting in it — one nobody asked to keep.
    open(BOARD);

    choose(/^Your name/);
    fireEvent.change(within(dialog()).getByRole("textbox"), {
      target: { value: "Grace" },
    });
    fireEvent.click(inDialog("Cancel"));

    expect(collab.setUserName).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("resetting the canvas", () => {
  it("says what it will take with it, which differs in a room", () => {
    // On `/` the browser's saved copy goes too; in a room it is everyone's
    // drawing that goes, and the saved copy is a different drawing entirely.
    const { unmount } = open(LOCAL);
    choose(/^Reset the canvas/);
    expect(dialog().textContent).toContain("this browser's saved copy");
    unmount();

    open(BOARD);

    choose(/^Reset the canvas/);
    expect(dialog().textContent).toContain("for everyone in the room");
  });

  it("empties the canvas and forgets the saved copy", () => {
    /*
     * Both halves: emptying alone would be autosaved back over the stored entry a
     * debounce later, and the drawing would return on the next visit.
     */
    storeLocalScene([box("a")]);
    open({ ...LOCAL, initialElements: [box("a")] });

    choose(/^Reset the canvas/);
    fireEvent.click(inDialog("Reset"));

    expect(paintedIds()).toEqual([]);
    expect(window.localStorage.getItem(LOCAL_SCENE_KEY)).toBeNull();
    expect(toasts()).toContain("Canvas cleared");
  });

  it("leaves the saved copy alone when the reset happens in a room", () => {
    // In a room the stored scene is the solo drawing left behind before sharing,
    // and this reset is not about that one.
    storeLocalScene([box("from-before")]);
    open({ ...BOARD, initialElements: [box("a")] });

    choose(/^Reset the canvas/);
    fireEvent.click(inDialog("Reset"));

    expect(paintedIds()).toEqual([]);
    expect(window.localStorage.getItem(LOCAL_SCENE_KEY)).toBeTruthy();
  });

  it("does nothing when the question is declined", () => {
    open({ ...LOCAL, initialElements: [box("a")] });

    choose(/^Reset the canvas/);
    fireEvent.click(inDialog("Cancel"));

    expect(paintedIds()).toEqual(["a"]);
  });
});

describe("copying the room link", () => {
  it("says the link is on the clipboard", async () => {
    // The clipboard write leaves nothing on screen, so the toast is the receipt.
    open(BOARD);

    choose(/^Copy collaboration link/);
    await settle();

    expect(collab.copyShareableLink).toHaveBeenCalledTimes(1);
    expect(toasts()).toContain("Link copied");
  });

  it("names the way out when the clipboard refuses", async () => {
    // A denied permission or an insecure origin: the link is still in the address
    // bar, and saying so beats a silent no-op.
    copyWorks = false;
    open(BOARD);

    choose(/^Copy collaboration link/);
    await settle();

    expect(toasts()).toContain("copy it from the address bar");
  });

  it("is on both bars as well as in the menu, and copies from either", async () => {
    /*
     * Three controls, one clipboard write. The same slot starts a session on `/`,
     * so each of them is a conditional — and a share button that starts a *second*
     * session from inside a room is the failure the condition is there to prevent.
     */
    open(BOARD);

    fireEvent.click(button("Copy share link"));
    fireEvent.click(button("Share link"));
    await settle();

    expect(collab.copyShareableLink).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("saving to a file", () => {
  it("downloads the scene under a dated name, and releases the blob", () => {
    /*
     * The only copy that outlives a cleared browser and a deleted board, so it is
     * offered on every canvas. The object URL is revoked straight after the click:
     * held, it pins the whole serialised scene in memory for the life of the page.
     */
    open({ ...LOCAL, initialElements: [box("a")] });

    choose(/^Save to file/);

    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toMatch(/^collabdraw-\d{4}-\d{2}-\d{2}\.collabdraw$/);
    expect(clicked[0].href).toBe(objectUrls[0]);
    expect(revoked).toEqual(objectUrls);
    expect(toasts()).toContain("Scene saved to your downloads");
  });
});

describe("opening a file", () => {
  it("goes through a hidden input that accepts the app's own documents", () => {
    // `.collabdraw` is a JSON file; the second entry is what a browser that maps
    // the extension to nothing needs in order to leave the file selectable.
    open(LOCAL);

    expect(filePicker().accept).toBe(".collabdraw,application/json");
    expect(filePicker().className).toContain("hidden");
  });

  it("is what the menu item opens", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    open(LOCAL);

    choose(/^Open…/);

    expect(click).toHaveBeenCalledTimes(1);
  });

  it("replaces the scene with the file's, pan and zoom included", async () => {
    /*
     * A whole document, so it becomes the baseline rather than an undoable edit —
     * Ctrl+Z after opening a file should not walk back into the drawing that was
     * on screen before it.
     */
    open({ ...LOCAL, initialElements: [box("on-screen")] });

    await pickFile("drawing.collabdraw", serializeScene([box("from-file")], AT_250));

    expect(paintedIds()).toEqual(["from-file"]);
    expect(zoomReadout()).toBe("250%");
    expect(canUndo()).toBe(false);
    expect(toasts()).toContain("drawing.collabdraw");
  });

  it("tells the room, which cannot see the file", async () => {
    // `resetHistory` does not broadcast, so without this the opener sees the file
    // and everybody else sees the old drawing.
    open({ ...BOARD, initialElements: [box("on-screen")] });

    await pickFile("drawing.collabdraw", serializeScene([box("from-file")], null));

    const [sent] = vi.mocked(collab.sendScene).mock.calls.at(-1)!;
    expect(sent.map((element) => element.id)).toEqual(["from-file"]);
  });

  it("keeps the drawing when the file is not one of ours", async () => {
    // Any file at all can be chosen — the input's `accept` is a filter, not a
    // guarantee — so a photo or someone else's JSON must not blank the canvas.
    open({ ...LOCAL, initialElements: [box("on-screen")] });

    await pickFile("holiday.png", "PNG not json at all");

    expect(paintedIds()).toEqual(["on-screen"]);
    expect(toasts()).toContain("That is not a .collabdraw scene.");
  });

  it("leaves the input empty, so the same file can be opened twice", async () => {
    // A file input holding the same value fires no `change` event, and reopening
    // the file you just opened is exactly what you do after a bad edit.
    open(LOCAL);

    await pickFile("drawing.collabdraw", serializeScene([box("from-file")], null));

    expect(filePicker().value).toBe("");
  });

  it("does nothing at all when the dialog is dismissed", async () => {
    // Cancelling fires `change` with an empty list on some browsers, and the
    // drawing on screen is not the one being opened.
    open({ ...LOCAL, initialElements: [box("on-screen")] });

    await act(async () => {
      fireEvent.change(filePicker(), { target: { files: [] } });
    });

    expect(paintedIds()).toEqual(["on-screen"]);
    expect(toasts()).toBe("");
  });
});

describe("the warnings that stay up", () => {
  it("says when this browser has stopped saving, and how to keep the drawing", async () => {
    /*
     * A full quota leaves the drawing in this tab and nowhere else, so the notice
     * has no timeout and names the way out. Nothing else on screen changes: the
     * canvas keeps working, which is what makes silence here dangerous.
     */
    open({ ...LOCAL, initialElements: [box("a")] });
    fillStorage();

    await tick(SAVE_DEBOUNCE_MS + 50);

    expect(toasts()).toContain("storage is full");
    expect(toasts()).toContain("use Save to file to keep it");
  });

  it("says when saving starts working again", async () => {
    // Only to somebody who was told it had stopped — an announcement about a
    // problem they never had would be noise.
    open({ ...LOCAL, initialElements: [box("a")] });
    const refuse = fillStorage();
    await tick(SAVE_DEBOUNCE_MS + 50);

    refuse.mockRestore();
    selectAll();
    fireEvent.click(inSection("Stroke", "#e03131"));
    await tick(SAVE_DEBOUNCE_MS + 50);

    expect(toasts()).toContain("Saving to this browser again.");
  });

  it("stays quiet on a canvas that is saving fine", async () => {
    open({ ...LOCAL, initialElements: [box("a")] });

    await tick(SAVE_DEBOUNCE_MS + 50);

    expect(toasts()).toBe("");
  });

  it.each([
    ["deleted", "This board was deleted"],
    ["too-large", "too large to save"],
    ["unreachable", "cannot be reached"],
  ] as const)("says why the room's drawing is not being kept (%s)", async (reason, said) => {
    /*
     * Only the server can see this, and it used to be a line in its log while the
     * room drew on into a 24-hour cache — so the work existed right up until it
     * did not.
     */
    collab.scenePersistence = { durable: false, reason };
    open(BOARD);
    await settle();

    expect(toasts()).toContain(said);
  });

  it("says when the board is being kept again, having said it was not", async () => {
    collab.scenePersistence = { durable: false, reason: "unreachable" };
    const { update } = open(BOARD);
    await settle();

    collab.scenePersistence = { durable: true, reason: null };
    update({});
    await settle();

    expect(toasts()).toContain("This board is being saved again.");
  });

  it("says nothing to a room that was never in trouble", async () => {
    // `durable: true` is also the answer on the first successful write of a
    // healthy room, and "being saved again" would be the first anyone heard of it.
    collab.scenePersistence = { durable: true, reason: null };
    open(BOARD);
    await settle();

    expect(toasts()).toBe("");
  });

  it("says nothing until the server has an answer", async () => {
    // `null` is "not known yet", which is every room's first moment.
    open(BOARD);
    await settle();

    expect(toasts()).toBe("");
  });
});

describe("the properties panel", () => {
  it("stays away with the selection tool in hand and nothing selected", () => {
    // There is nothing for it to style: the panel would be a column of controls
    // over the canvas that change nothing.
    open({ ...LOCAL, initialElements: [box("a")] });

    expect(screen.queryByText("Stroke")).toBeNull();
  });

  it("comes back for a selection", () => {
    open({ ...LOCAL, initialElements: [box("a")] });

    selectAll();

    expect(screen.queryByText("Stroke")).toBeTruthy();
  });

  it("comes back for a drawing tool, before anything is drawn", () => {
    // What it shows then is what the *next* shape will be drawn with.
    open(LOCAL);

    pickTool("r");

    expect(screen.queryByText("Stroke")).toBeTruthy();
  });

  it("offers a background to a shape that can hold one", () => {
    open(LOCAL);

    pickTool("r");

    expect(screen.queryByText("Background")).toBeTruthy();
    expect(screen.queryByText("Arrow shape")).toBeNull();
  });

  it("offers neither a background nor an arrow shape to freehand", () => {
    // A pen stroke is a line with no interior and no ends to shape.
    open(LOCAL);

    pickTool("p");

    expect(screen.queryByText("Background")).toBeNull();
    expect(screen.queryByText("Arrow shape")).toBeNull();
  });

  it("offers the arrow shape to arrows and lines", () => {
    const { unmount } = open(LOCAL);
    pickTool("a");
    expect(screen.queryByText("Arrow shape")).toBeTruthy();
    unmount();

    open(LOCAL);

    pickTool("l");
    expect(screen.queryByText("Arrow shape")).toBeTruthy();
  });

  it("follows the selection rather than the tool once there is one", () => {
    /*
     * Selecting a rectangle with the arrow tool still in hand: the controls belong
     * to what is selected, because that is what a change will be applied to.
     *
     * Right-clicking is how the two coexist — Ctrl+A goes back to the selection
     * tool, and switching tools clears the selection.
     */
    open({ ...LOCAL, initialElements: [box("a")] });

    pickTool("a");
    fireEvent.contextMenu(surface(), { clientX: 20, clientY: 1 });

    expect(screen.queryByText("Background")).toBeTruthy();
    expect(screen.queryByText("Arrow shape")).toBeNull();
  });
});

describe("the right-click menu", () => {
  /*
   * jsdom lays nothing out, so the canvas sits at 0,0 and a client point is a
   * world point at 1:1. The fixture box is transparent, and a transparent shape is
   * grabbed by its outline rather than its middle — hence a point on the edge.
   */
  const onTheBox = { clientX: 20, clientY: 1 };
  const onNothing = { clientX: 600, clientY: 400 };

  it("selects what was pointed at, so its actions apply to that", () => {
    /*
     * Right-clicking a shape you had not selected used to open a menu whose Delete
     * and Copy were greyed out — the pointer was over the shape and the app did not
     * agree that it was the subject.
     */
    open({ ...LOCAL, initialElements: [box("a")] });

    fireEvent.contextMenu(surface(), onTheBox);

    expect(onCanvas(/^Delete/).disabled).toBe(false);
    expect(onCanvas(/^Copy/).disabled).toBe(false);
    expect(screen.queryByText("Actions")).toBeTruthy();
  });

  it("clears the selection when the click lands on nothing", () => {
    // The menu still opens — Select all and Paste are worth having over empty
    // canvas — but the six actions that need a subject have none.
    open({ ...LOCAL, initialElements: [box("a")] });
    selectAll();

    fireEvent.contextMenu(surface(), onNothing);

    expect(onCanvas(/^Delete/).disabled).toBe(true);
    expect(onCanvas(/^Duplicate/).disabled).toBe(true);
    expect(onCanvas(/^Select all/).disabled).toBe(false);
  });

  it("greys out Select all on an empty canvas, and Paste with an empty clipboard", () => {
    open(LOCAL);

    fireEvent.contextMenu(surface(), onTheBox);

    expect(onCanvas(/^Select all/).disabled).toBe(true);
    expect(onCanvas(/^Paste/).disabled).toBe(true);
  });

  it("does the action, and closes", () => {
    open({ ...LOCAL, initialElements: [box("a")] });

    fireEvent.contextMenu(surface(), onTheBox);
    fireEvent.click(onCanvas(/^Delete/));

    expect(paintedIds()).toEqual([]);
    expect(rightClickMenu()).toBeNull();
  });

  it("teaches the shortcut for each action", () => {
    // The menu is where the keyboard is learned, so every item that has a
    // shortcut shows it.
    open({ ...LOCAL, initialElements: [box("a")] });

    fireEvent.contextMenu(surface(), onTheBox);

    expect(onCanvas(/^Duplicate/).textContent).toContain("Ctrl+D");
    expect(onCanvas(/^Bring to front/).textContent).toContain("Ctrl+Shift+]");
  });

  it("keeps a selection of several when the click lands inside it", () => {
    /*
     * The other way round from the test above: a right-click on a shape that is
     * already part of the selection must not narrow it to that one shape, or
     * "select five, right-click, Delete" would delete one of them.
     */
    open({ ...LOCAL, initialElements: [box("a"), box("b", 100, 0)] });
    selectAll();

    fireEvent.contextMenu(surface(), onTheBox);
    fireEvent.click(onCanvas(/^Delete/));

    expect(paintedIds()).toEqual([]);
  });

  it("closes on Escape without doing anything", () => {
    open({ ...LOCAL, initialElements: [box("a")] });

    fireEvent.contextMenu(surface(), onTheBox);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(rightClickMenu()).toBeNull();
    expect(paintedIds()).toEqual(["a"]);
  });
});

describe("another tab of the same browser", () => {
  /*
   * Both tabs autosave the whole scene under one key, so the last writer used to
   * win outright: draw in a second tab and the first tab's next save discarded
   * its work. `useLocalSceneAutosave` hears the write and `reconcileScenes`
   * merges it; what is left here is adopting the result — and adopting it as
   * somebody else's edit rather than as one of this tab's own.
   */
  const otherTabSaved = async (elements: Shape[]) => {
    storeLocalScene(elements);
    // The `storage` event only ever fires in the *other* tabs, so jsdom raises
    // none for a write made here; the listener re-reads the store anyway.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LOCAL_SCENE_KEY,
        storageArea: window.localStorage,
      }),
    );
    await tick(STORAGE_SYNC_DEBOUNCE_MS + 20);
  };

  it("takes on what the other tab drew, and keeps what this one has", async () => {
    storeLocalScene([box("a")]);
    open(LOCAL);

    await otherTabSaved([box("a"), box("b", 100, 0)]);

    expect(paintedIds()).toEqual(["a", "b"]);
  });

  it("does not put the other tab's work on this tab's undo stack", async () => {
    // Ctrl+Z here would otherwise revert an edit made over there, which is both
    // a surprise and unrepeatable — there is no redo for it in that tab.
    storeLocalScene([box("a")]);
    open(LOCAL);

    await otherTabSaved([box("a"), box("b", 100, 0)]);

    expect(canUndo()).toBe(false);
  });

  it("follows a deletion, and forgets the deleted shape was selected", async () => {
    // A selection naming an element that is no longer in the scene leaves the
    // panel offering to delete and duplicate nothing.
    storeLocalScene([box("a")]);
    open(LOCAL);
    selectAll();

    await otherTabSaved([]);

    expect(paintedIds()).toEqual([]);
    expect(screen.queryByText("Actions")).toBeNull();
  });

  it("ignores the stored scene entirely inside a room", async () => {
    // There the server holds the authoritative scene, and the stored copy is the
    // solo drawing left behind before sharing.
    open({ ...BOARD, initialElements: [box("in-the-room")] });

    await otherTabSaved([box("elsewhere")]);

    expect(paintedIds()).toEqual(["in-the-room"]);
  });
});

describe("restyling", () => {
  /**
   * A painted shape's own value for a style key. Read loosely on purpose: `fill`
   * belongs to every shape and `edgeStyle` only to arrows and lines, and the
   * point of these tests is which of them ended up carrying what.
   */
  const styleOf = (index: number, key: string) =>
    (painted()[index] as unknown as Record<string, unknown>)[key];

  it("only remembers the style for the next shape when nothing is selected", () => {
    /*
     * The panel is the defaults editor as well as the selection's editor, and it
     * is on show with a tool in hand and nothing selected. Restyling the whole
     * scene from there would be the alternative reading.
     */
    open({ ...LOCAL, initialElements: [box("a")] });
    pickTool("r");

    fireEvent.click(inSection("Stroke", "#e03131"));

    expect(styleOf(0, "stroke")).toBe(DEFAULT_STYLE.stroke);
    expect(canUndo()).toBe(false);
  });

  it("touches only what is selected, not everything on the canvas", () => {
    /*
     * The patch is applied by id. Two rectangles with one of them selected is the
     * case that tells the two readings apart — "restyle the selection" and
     * "restyle the scene" look identical when everything is selected.
     */
    open({ ...LOCAL, initialElements: [box("a"), box("b", 100, 0)] });
    fireEvent.contextMenu(surface(), { clientX: 20, clientY: 1 });

    fireEvent.click(inSection("Stroke", "#e03131"));

    expect(styleOf(0, "stroke")).toBe("#e03131");
    expect(styleOf(1, "stroke")).toBe(DEFAULT_STYLE.stroke);
  });

  it("skips a fill on the shapes in the selection that cannot show one", () => {
    /*
     * A background over a rectangle and a line together: the rectangle takes it,
     * and the line — which has no interior — must not, or it ends up carrying a
     * fill that only shows as a hachured band when it is later made into a shape.
     */
    const line = createElement("Line", { id: "l", x1: 0, y1: 0, x2: 60, y2: 40 })!;
    open({ ...LOCAL, initialElements: [box("a"), line] });
    selectAll();

    fireEvent.click(inSection("Background", "#ffec99"));

    expect(styleOf(0, "fill")).toBe("#ffec99");
    expect(styleOf(1, "fill")).toBe(DEFAULT_STYLE.fill);
  });

  it("still restyles everything else about that line", () => {
    // Only the fill is dropped; the stroke is the whole point of picking one.
    const line = createElement("Line", { id: "l", x1: 0, y1: 0, x2: 60, y2: 40 })!;
    open({ ...LOCAL, initialElements: [box("a"), line] });
    selectAll();

    fireEvent.click(inSection("Stroke", "#1971c2"));

    expect(styleOf(0, "stroke")).toBe("#1971c2");
    expect(styleOf(1, "stroke")).toBe("#1971c2");
  });

  it("changes an arrow's shape, which is a change of route", () => {
    // Elbow and curved are different paths between the same two ends, so anything
    // bound to the arrow is re-resolved against the new one.
    const arrow = createElement("Arrow", { id: "r", x1: 0, y1: 0, x2: 80, y2: 0 })!;
    open({ ...LOCAL, initialElements: [arrow] });
    selectAll();

    fireEvent.click(inSection("Arrow shape", "Elbow"));

    expect(styleOf(0, "edgeStyle")).toBe("elbow");
  });
});

describe("Escape", () => {
  it("gives up the selection first and the tool second", () => {
    /*
     * One rung per press. Dropping both at once means reaching for the tool again
     * after every stray Escape, and dropping neither leaves the previous shape
     * selected under the next one drawn.
     */
    open({ ...LOCAL, initialElements: [box("a")] });
    pickTool("a");
    // Right-clicking selects without leaving the tool, which Ctrl+A would.
    fireEvent.contextMenu(surface(), { clientX: 20, clientY: 1 });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByText("Actions")).toBeNull();
    expect(screen.queryByText("Arrow shape")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByText("Stroke")).toBeNull();
  });

  it("keeps the drawing through all of it", () => {
    // Escape cancels what is in progress; it is not a delete.
    open({ ...LOCAL, initialElements: [box("a")] });
    selectAll();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(paintedIds()).toEqual(["a"]);
  });
});

describe("moving a shape through the stack", () => {
  /*
   * Paint order is z-order, so the whole subject is readable off what was
   * painted. Three shapes, because "forward" and "to front" do the same thing to
   * a stack of two.
   */
  const three = () => [box("a", 0, 0), box("b", 100, 0), box("c", 200, 0)];
  /** Right-click selects what it lands on — here the bottom shape, alone. */
  const selectBottom = () =>
    fireEvent.contextMenu(surface(), { clientX: 20, clientY: 1 });

  it("steps past one neighbour, or jumps the whole stack, per the modifier", () => {
    // Shift is the difference between the two, and it is easy to wire the pair of
    // them the wrong way round — the shortcuts read almost identically.
    open({ ...LOCAL, initialElements: three() });
    selectBottom();

    fireEvent.keyDown(window, { key: "]", ctrlKey: true });
    expect(paintedIds()).toEqual(["b", "a", "c"]);

    fireEvent.keyDown(window, { key: "]", ctrlKey: true, shiftKey: true });
    expect(paintedIds()).toEqual(["b", "c", "a"]);

    fireEvent.keyDown(window, { key: "[", ctrlKey: true });
    expect(paintedIds()).toEqual(["b", "a", "c"]);

    fireEvent.keyDown(window, { key: "[", ctrlKey: true, shiftKey: true });
    expect(paintedIds()).toEqual(["a", "b", "c"]);
  });

  it("is the same command from the right-click menu and from the panel", () => {
    /*
     * Three routes to one behaviour: the keyboard for speed, the menu where the
     * pointer already is, the panel for a selection made a while ago. All four
     * buttons are pressed because each is its own line of wiring, and front and
     * back are a pair that reads the same at a glance.
     */
    open({ ...LOCAL, initialElements: three() });
    selectBottom();

    fireEvent.click(onCanvas(/^Bring to front/));
    expect(paintedIds()).toEqual(["b", "c", "a"]);

    // The menu closed on that choice, and the shapes are side by side, so this
    // lands on "a" again wherever it now sits in the stack.
    selectBottom();
    fireEvent.click(onCanvas(/^Send to back/));
    expect(paintedIds()).toEqual(["a", "b", "c"]);

    fireEvent.click(inSection("Actions", "Bring to front — Ctrl+Shift+]"));
    expect(paintedIds()).toEqual(["b", "c", "a"]);

    fireEvent.click(inSection("Actions", "Send to back — Ctrl+Shift+["));
    expect(paintedIds()).toEqual(["a", "b", "c"]);
  });
});

describe("the commands only the keyboard has", () => {
  it("toggles the tool lock, the same preference the menu spells out", () => {
    // Q is the only binding for it, and the menu is the only readout — so this is
    // the join: the shortcut and the menu item are one preference, not two.
    open(LOCAL);

    fireEvent.keyDown(window, { key: "q" });
    openMenu();

    expect(item(/^Keep selected tool active/).textContent).toContain("Off");
  });

  it("goes back to 1:1 when there is nothing to fit", () => {
    /*
     * Shift+1 fits the selection, or failing that the scene, or failing that
     * nothing at all — and an empty canvas is the case with no right answer, so it
     * resets rather than dividing by an empty box.
     */
    storeLocalScene([], AT_250);
    open(LOCAL);
    expect(zoomReadout()).toBe("250%");

    fireEvent.keyDown(window, { key: "!", shiftKey: true });

    expect(zoomReadout()).toBe("100%");
  });
});

describe("the zoom controls", () => {
  it("fits from either bar's button, not only from Shift+1", () => {
    /*
     * Both bars wire the button themselves, and the phone's is behind a chip that
     * has to be opened — so neither is reached by the keyboard's test. The
     * assertion is only "back to 1:1", which is what fitting an empty canvas does;
     * the step the zoom takes in between is `useViewport`'s business.
     */
    storeLocalScene([], AT_250);
    open(LOCAL);

    fireEvent.click(button("Zoom to fit"));
    expect(zoomReadout()).toBe("100%");

    fireEvent.click(button("Zoom in"));
    expect(zoomReadout()).not.toBe("100%");

    // From here the phone's chip is open, so every zoom control exists twice.
    fireEvent.click(button("Zoom controls"));
    fireEvent.click(screen.getAllByRole("button", { name: "Zoom to fit" })[1]);

    expect(screen.getAllByRole("button", { name: "Reset zoom" })[0].textContent).toBe(
      "100%",
    );
  });
});

describe("where your cursor is", () => {
  it("goes out in world coordinates, so it lands where you are pointing", () => {
    /*
     * Sent in screen pixels, a cursor appears wherever the *peer's* scroll and
     * zoom put those pixels — metres away from the shape being pointed at.
     *
     * jsdom lays nothing out, so the canvas is at 0,0: at 250% scrolled to
     * (−40, 20), the client point (100, 50) is world (80, 0).
     */
    open({ ...BOARD, initialViewport: AT_250 });

    fireEvent.pointerMove(surface(), { clientX: 100, clientY: 50 });

    expect(collab.sendCursor).toHaveBeenCalledWith({ x: 80, y: 0 });
  });

  it("says nothing on a canvas that is not shared", () => {
    open(LOCAL);

    fireEvent.pointerMove(surface(), { clientX: 100, clientY: 50 });

    expect(collab.sendCursor).not.toHaveBeenCalled();
  });
});

describe("typing on the canvas", () => {
  const editor = () => document.querySelector("textarea");
  /** Press the text tool down on empty canvas, which is how text is started. */
  const pressWithTextTool = () => {
    pickTool("t");
    fireEvent.pointerDown(surface(), {
      clientX: 40,
      clientY: 40,
      button: 0,
      pointerId: 1,
    });
  };
  const paintedText = () =>
    painted().map((element) => ("text" in element ? element.text : null));

  it("opens a textarea, and stops painting the element behind it", () => {
    /*
     * The textarea *is* the element while it is open — same position, same font —
     * so painting the element as well shows every glyph twice, and the caret
     * lands between two copies of the text.
     */
    open(LOCAL);

    pressWithTextTool();

    expect(editor()).toBeTruthy();
    expect(painted()).toEqual([]);
  });

  it("paints what was typed once the edit is over", () => {
    open(LOCAL);
    pressWithTextTool();

    fireEvent.change(editor()!, { target: { value: "hello" } });
    fireEvent.keyDown(editor()!, { key: "Escape" });

    expect(paintedText()).toEqual(["hello"]);
    expect(editor()).toBeNull();
  });

  it("throws away an element that was left empty", () => {
    // Reaching for the text tool and thinking better of it should not leave an
    // invisible zero-width element behind to be selected by accident.
    open(LOCAL);
    pressWithTextTool();

    fireEvent.keyDown(editor()!, { key: "Escape" });

    expect(painted()).toEqual([]);
  });

  it("keeps the canvas's shortcuts out of the text", () => {
    // `r` is the rectangle tool and Delete deletes the selection — which here is
    // the element being typed into. Inside the editor they are a character and a
    // rub-out, and the editor has to stay open through both.
    open(LOCAL);
    pressWithTextTool();

    fireEvent.keyDown(editor()!, { key: "r" });
    fireEvent.keyDown(editor()!, { key: "Delete" });

    expect(editor()).toBeTruthy();
    expect(screen.queryByText("Background")).toBeNull();
  });
});

describe("the properties sheet on a phone", () => {
  /*
   * The same `StylePanel`, brought up over the drawing instead of docked beside
   * it — so with the sheet open there are two of them in the tree, and every
   * query here is scoped to the sheet. Its wrapper is the only `animate-slide-up`
   * on screen while the menu drawer is shut.
   */
  const sheet = () => document.querySelector<HTMLElement>(".animate-slide-up");
  const inSheet = (name: string) =>
    within(sheet()!).getByRole("button", { name });
  const backdrop = () => document.querySelector<HTMLElement>('[class*="bg-black/30"]')!;
  /** A selection the drawing tool does not clear, so the sheet has a subject. */
  const selectWithToolInHand = () => {
    pickTool("r");
    fireEvent.contextMenu(surface(), { clientX: 20, clientY: 1 });
  };

  it("comes up from the dock, over the drawing", () => {
    open({ ...LOCAL, initialElements: [box("a")] });
    selectAll();

    fireEvent.click(button("Element Properties"));

    expect(sheet()).toBeTruthy();
    expect(screen.getAllByText("Stroke")).toHaveLength(2);
  });

  it("closes on its cross, and on the drawing behind it", () => {
    // A sheet over the canvas needs both: the cross for the deliberate way out,
    // the backdrop because that is how every other sheet on a phone behaves.
    open({ ...LOCAL, initialElements: [box("a")] });
    selectAll();

    fireEvent.click(button("Element Properties"));
    fireEvent.click(inSheet("Close properties"));
    expect(sheet()).toBeNull();

    fireEvent.click(button("Element Properties"));
    fireEvent.click(backdrop());

    expect(sheet()).toBeNull();
  });

  it("gets out of the way when the deletion is made from it", () => {
    /*
     * The sheet covers the drawing, and seeing the shape go is the point of
     * deleting it. The tool stays in hand here so the sheet *could* have stayed
     * open — with the selection tool it would close either way.
     */
    open({ ...LOCAL, initialElements: [box("a")] });
    selectWithToolInHand();
    fireEvent.click(button("Element Properties"));

    fireEvent.click(inSheet("Delete"));

    expect(paintedIds()).toEqual([]);
    expect(sheet()).toBeNull();
  });

  it("restyles from the sheet, the same as from the panel", () => {
    open({ ...LOCAL, initialElements: [box("a")] });
    selectWithToolInHand();
    fireEvent.click(button("Element Properties"));

    fireEvent.click(within(sheet()!).getByRole("button", { name: "#e03131" }));

    expect((painted()[0] as unknown as Record<string, unknown>).stroke).toBe(
      "#e03131",
    );
  });

  it("stays up while the shape is moved through the stack", () => {
    /*
     * Unlike Delete, these leave something to look at, and one press is rarely
     * enough — a sheet that closed on each would be reopened for every step.
     */
    open({
      ...LOCAL,
      initialElements: [box("a"), box("b", 100, 0), box("c", 200, 0)],
    });
    selectWithToolInHand();
    fireEvent.click(button("Element Properties"));

    fireEvent.click(inSheet("Bring to front — Ctrl+Shift+]"));
    expect(paintedIds()).toEqual(["b", "c", "a"]);

    fireEvent.click(inSheet("Send to back — Ctrl+Shift+["));
    expect(paintedIds()).toEqual(["a", "b", "c"]);
    expect(sheet()).toBeTruthy();
  });
});

describe("the assistant", () => {
  const closer = () => screen.queryByRole("button", { name: "Close the assistant" });
  /** Both bars carry the button; the index picks which one is pressed. */
  const assistant = (which = 0) =>
    screen.getAllByRole("button", { name: "Assistant" })[which];

  it("opens from the toolbar and closes on its own cross", () => {
    open(LOCAL);
    expect(closer()).toBeNull();

    fireEvent.click(assistant(0));
    expect(closer()).toBeTruthy();

    fireEvent.click(closer()!);

    expect(closer()).toBeNull();
  });

  it("is one panel behind both buttons, and both say it is open", () => {
    // The phone bar's button and the toolbar's are the same toggle; a second
    // piece of state for the second button is how they end up disagreeing.
    open(LOCAL);

    fireEvent.click(assistant(1));

    expect(closer()).toBeTruthy();
    for (const control of screen.getAllByRole("button", { name: "Assistant" })) {
      expect(control.getAttribute("aria-pressed")).toBe("true");
    }
  });
});

describe("whether the room is live", () => {
  it("spells it out beside the zoom, and abbreviates it on a phone", () => {
    /*
     * Strokes keep landing on the local canvas while the socket is down, so
     * nothing else on screen says the work has stopped being shared.
     */
    const { update } = open(BOARD);

    expect(screen.getAllByText("Live")).toHaveLength(2);

    collab.isConnected = false;
    update({});

    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByLabelText("Offline").textContent).toBe("Off");
  });

  it("says nothing at all on a canvas that is not shared", () => {
    // "Off" beside the zoom on a drawing that was never shared would read as a
    // fault rather than as a fact.
    open(LOCAL);

    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.queryByText("Offline")).toBeNull();
  });
});

