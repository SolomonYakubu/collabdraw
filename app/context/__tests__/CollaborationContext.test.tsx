// @vitest-environment jsdom
/**
 * The provider is the whole client side of the wire: it opens the socket, keeps
 * everyone else's cursors and half-finished shapes, and is the only place a
 * message from another person becomes something this canvas draws.
 *
 * The failures it is written against, each named by a test below: ghosts — a
 * peer who closes their tab leaving a cursor and a half-drawn shape behind,
 * since the roster is the only notice of a departure the server sends; echoes —
 * your own message arriving back and being applied as though it were somebody
 * else's; a rename that tears the connection down, or that fails to survive a
 * reconnect; and the two throttles, which decide whether five people drawing is
 * a few dozen messages a second or a few thousand. Two things a room cannot get
 * back if they are wrong have their own sections: your display name, which two
 * open tabs used to fight over, and the server's answer to whether this room's
 * drawing is actually being kept.
 *
 * `socket.io-client` is faked. The fake records what the client sent and lets a
 * test deliver what the server would send, so both directions are assertable;
 * the transport and the server's own rules still need a running server.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The socket as both sides see it: what was sent, and who is listening. */
interface FakeSocket {
  connected: boolean;
  /** Every message the client sent, in order. */
  sent: Array<{
    event: string;
    payload: Record<string, unknown>;
    /** Volatile sends are dropped rather than queued when the link backs up. */
    volatile?: boolean;
  }>;
  listeners: Map<string, (payload: unknown) => void>;
  /** Manager-level listeners, `reconnect_failed` among them. */
  managerListeners: Map<string, () => void>;
  io: {
    on: (event: string, handler: () => void) => void;
  };
  teardowns: number;
  disconnects: number;
  on: (event: string, handler: (payload: unknown) => void) => void;
  emit: (event: string, payload: Record<string, unknown>) => void;
  volatile: { emit: (event: string, payload: Record<string, unknown>) => void };
  removeAllListeners: () => void;
  disconnect: () => void;
}

/** Every socket the provider has asked for, and the arguments it asked with. */
const sockets: FakeSocket[] = [];
const connections: Array<{ url: string; query: Record<string, unknown> }> = [];

const createFakeSocket = (): FakeSocket => {
  const socket: FakeSocket = {
    connected: false,
    sent: [],
    listeners: new Map(),
    managerListeners: new Map(),
    teardowns: 0,
    disconnects: 0,
    io: {
      on: (event, handler) => {
        socket.managerListeners.set(event, handler);
      },
    },
    on: (event, handler) => {
      socket.listeners.set(event, handler);
    },
    emit: (event, payload) => {
      socket.sent.push({ event, payload });
    },
    volatile: {
      emit: (event, payload) => {
        socket.sent.push({ event, payload, volatile: true });
      },
    },
    removeAllListeners: () => {
      socket.teardowns += 1;
      socket.listeners.clear();
    },
    disconnect: () => {
      socket.disconnects += 1;
      socket.connected = false;
    },
  };
  return socket;
};

vi.mock("socket.io-client", () => ({
  io: (url: string, options: { query?: Record<string, unknown> }) => {
    connections.push({ url, query: options?.query ?? {} });
    const socket = createFakeSocket();
    sockets.push(socket);
    return socket;
  },
}));

import {
  CollaborationContextProvider,
  useCollaborationContext,
  ELEMENT_COALESCE_MS,
  FREEHAND_FULL_EVERY,
  PENDING_THROTTLE_MS,
  TRANSIENT_COALESCE_MS,
  type CollaborationEventHandlers,
} from "../CollaborationContext";import {
  USER_ID_KEY,
  USER_NAME_KEY,
} from "../../services/collaboration/identity";
import { STORAGE_SYNC_DEBOUNCE_MS } from "../../services/storageSync";
import { createElement } from "../../services/canvas/elements";
import type { Shape } from "../../types/shapes";

/** This client's own presence id, seeded so a test can echo a message back. */
const ME = "me";

/** The socket the provider has open: the last one it asked for. */
const socket = () => sockets[sockets.length - 1];

/** Play the server — deliver one message to the provider's listener. */
const deliver = (event: string, payload?: unknown) =>
  act(() => {
    socket().listeners.get(event)?.(payload);
  });

/** Let time pass, so the throttles clear and the stale sweep comes round. */
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

/** The ids of a scene handed to a handler, which is what the canvas draws. */
const ids = (scene: unknown) => (scene as Shape[]).map((element) => element.id);

/** Bring the socket up the way socket.io does: connected, then the event. */
const goOnline = () => {
  socket().connected = true;
  deliver("connect");
};

/** What the client sent on one event, oldest first. */
const sentOn = (event: string) =>
  socket()
    .sent.filter((message) => message.event === event)
    .map((message) => message.payload);

/** An element as it arrives over the wire: untrusted, so only `tool` is sure. */
const wireShape = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  tool: "Square",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...extra,
});

/** The name, plus a button that renames the way the menu does. */
const NameProbe = () => {
  const { userName, setUserName } = useCollaborationContext();
  return (
    <button type="button" onClick={() => setUserName("Renamed Here")}>
      {userName || "(none)"}
    </button>
  );
};

const mount = () =>
  render(
    <CollaborationContextProvider roomId={null}>
      <NameProbe />
    </CollaborationContextProvider>,
  );

const shownName = () => screen.getByRole("button").textContent;

/** What the browser delivers when the *other* tab writes the name. */
const otherTabRenames = (name: string | null) =>
  act(() => {
    if (name === null) {
      window.localStorage.removeItem(USER_NAME_KEY);
    } else {
      window.localStorage.setItem(USER_NAME_KEY, name);
    }
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: USER_NAME_KEY,
        newValue: name,
        storageArea: window.localStorage,
      }),
    );
    vi.advanceTimersByTime(STORAGE_SYNC_DEBOUNCE_MS);
  });

/** The context as the canvas holds it, so a test can call into it. */
let api: ReturnType<typeof useCollaborationContext>;
/** How often the cursor map's identity changed — every repaint of the overlay. */
let cursorUpdates = 0;
/** How often a consumer was told the durability answer changed. */
let announcements = 0;

const RoomProbe = ({
  handlers,
}: {
  handlers?: CollaborationEventHandlers;
}) => {
  api = useCollaborationContext();
  const { cursors, setEventHandlers } = api;

  useEffect(() => {
    if (handlers) {
      setEventHandlers(handlers);
    }
  }, [handlers, setEventHandlers]);

  useEffect(() => {
    cursorUpdates += 1;
  }, [cursors]);

  return (
    <>
      <p data-testid="connected">{String(api.isConnected)}</p>
      <p data-testid="roster">{api.users.map((user) => user.tag).join(", ")}</p>
      <p data-testid="cursors">
        {Object.entries(cursors)
          .map(([id, cursor]) => `${id}:${cursor.tag}@${cursor.x},${cursor.y}`)
          .join(" ")}
      </p>
      <p data-testid="drawing">
        {Object.keys(api.remoteInProgress).sort().join(" ")}
      </p>
    </>
  );
};

const mountInRoom = (
  roomId: string | null = "room1",
  handlers?: CollaborationEventHandlers,
) =>
  render(
    <CollaborationContextProvider roomId={roomId}>
      <RoomProbe handlers={handlers} />
    </CollaborationContextProvider>,
  );

const text = (id: string) => screen.getByTestId(id).textContent;

/** Links the clipboard accepted, so a test can see what would be pasted. */
let copied: string[];

const withClipboard = (writeText: (value: string) => Promise<void>) =>
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

/** No clipboard at all: what plain HTTP and older browsers give you. */
const withoutClipboard = () =>
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  connections.length = 0;
  announcements = 0;
  cursorUpdates = 0;
  copied = [];
  withClipboard(async (value: string) => {
    copied.push(value);
  });
  window.localStorage.clear();
  window.localStorage.setItem(USER_ID_KEY, ME);
  window.localStorage.setItem(USER_NAME_KEY, "Ada");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reaching the context", () => {
  it("refuses to hand out a value outside a provider", () => {
    /*
     * The alternative to throwing is `undefined`, which fails later and
     * somewhere else: a toolbar whose share button does nothing, or a canvas
     * that draws locally and never joins the room. The message names the
     * provider so the fix is the next thing the developer reads.
     */
    const Orphan = () => {
      useCollaborationContext();
      return null;
    };
    // React re-throws through its own error logging, which is not the failure.
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => render(<Orphan />)).toThrow(
      /within a CollaborationContextProvider/,
    );
  });
});

describe("display name", () => {
  it("starts from what is stored", () => {
    mount();
    expect(shownName()).toBe("Ada");
  });

  it("adopts a rename made in another tab", () => {
    mount();

    otherTabRenames("Grace");

    expect(shownName()).toBe("Grace");
  });

  it("normalises what the other tab wrote", () => {
    mount();

    otherTabRenames("  Grace   Hopper  ");

    expect(shownName()).toBe("Grace Hopper");
  });

  it("ignores a blank name rather than showing an unlabelled cursor", () => {
    mount();

    otherTabRenames("   ");

    expect(shownName()).toBe("Ada");
  });

  it("ignores a cleared entry rather than minting a new name", () => {
    mount();

    otherTabRenames(null);

    expect(shownName()).toBe("Ada");
  });

  it("still renames from this tab, and keeps the stored value", () => {
    mount();

    act(() => {
      screen.getByRole("button").click();
    });

    expect(shownName()).toBe("Renamed Here");
    expect(window.localStorage.getItem(USER_NAME_KEY)).toBe("Renamed Here");
  });
});

describe("opening the socket", () => {
  it("identifies itself in the handshake, before a word is exchanged", () => {
    // The server builds its cluster-wide roster from the query, so a socket that
    // arrives without one is in the room without being in the list.
    mountInRoom();

    expect(connections).toHaveLength(1);
    expect(connections[0].query).toEqual({
      roomId: "room1",
      userId: ME,
      userTag: "Ada",
    });
  });

  it("opens nothing at all on the local canvas", () => {
    // `/` is a board with no room: the provider is mounted so the canvas can
    // read one hook unconditionally, and there is nobody to talk to.
    mountInRoom(null);

    expect(sockets).toHaveLength(0);
    expect(text("connected")).toBe("false");
  });

  it("joins the room once the socket is up, and says so", () => {
    mountInRoom();
    expect(text("connected")).toBe("false");

    goOnline();

    expect(sentOn("join-room")).toEqual([
      { roomId: "room1", userId: ME, userTag: "Ada" },
    ]);
    expect(text("connected")).toBe("true");
  });

  it("rejoins under the name it has now, not the one it opened with", () => {
    // A reconnect replays `join-room`, and the effect that registered the
    // handler captured the name as it was: reading that would revert a rename
    // made since, in front of everyone.
    mountInRoom();
    goOnline();

    act(() => {
      api.setUserName("Grace");
    });
    goOnline();

    expect(sentOn("join-room")[1].userTag).toBe("Grace");
  });

  it("does not reconnect to carry a rename", () => {
    // The name goes over the wire precisely so it does not have to: reopening
    // the socket drops everyone's cursors and re-runs hydration for a label.
    mountInRoom();
    goOnline();

    act(() => {
      api.setUserName("Grace");
    });

    expect(sockets).toHaveLength(1);
    expect(socket().disconnects).toBe(0);
  });

  it("hangs up on the way out", () => {
    // Both halves matter: a listener left attached sets state on a component
    // that is gone, and a socket left open keeps the room's user count wrong.
    const { unmount } = mountInRoom();
    goOnline();

    unmount();

    expect(socket().teardowns).toBe(1);
    expect(socket().disconnects).toBe(1);
  });

  it("takes a fresh socket into a new board and closes the old one", () => {
    const { rerender } = mountInRoom("room1");
    goOnline();

    rerender(
      <CollaborationContextProvider roomId="room2">
        <RoomProbe />
      </CollaborationContextProvider>,
    );

    expect(sockets).toHaveLength(2);
    expect(sockets[0].disconnects).toBe(1);
    expect(connections[1].query).toMatchObject({ roomId: "room2" });
  });
});

/**
 * Failover. Two Socket.IO servers are deployed behind one app; the client opens
 * the primary and, when that server has exhausted its reconnection attempts,
 * rotates to the backup and rejoins the room there. The rotation is an effect
 * re-run, so the old socket is closed before the new one is opened.
 */
describe("failing over to the backup server", () => {
  const PRIMARY = "http://primary.example:3001";
  const BACKUP = "http://backup.example:3001";
  let savedPrimary: string | undefined;
  let savedBackup: string | undefined;

  beforeEach(() => {
    savedPrimary = process.env.NEXT_PUBLIC_SOCKET_URL;
    savedBackup = process.env.NEXT_PUBLIC_SOCKET_URL_BACKUP;
    process.env.NEXT_PUBLIC_SOCKET_URL = PRIMARY;
  });

  afterEach(() => {
    /*
     * Restored with the empty string rather than `undefined`: assigning
     * `undefined` to a `process.env` key coerces it to the string "undefined",
     * which is truthy and would leave a nonsense backup URL behind.
     */
    process.env.NEXT_PUBLIC_SOCKET_URL = savedPrimary ?? "";
    process.env.NEXT_PUBLIC_SOCKET_URL_BACKUP = savedBackup ?? "";
  });

  /** The provider reads the env at render time, so a test sets it first. */
  const mountWithBackup = () => {
    process.env.NEXT_PUBLIC_SOCKET_URL_BACKUP = BACKUP;
    return mountInRoom();
  };

  /** Play the manager: this server's reconnection attempts are exhausted. */
  const exhaustPrimary = () => {
    act(() => {
      socket().managerListeners.get("reconnect_failed")?.();
    });
  };

  it("opens the backup when the primary gives up reconnecting", () => {
    mountWithBackup();
    expect(connections[0].url).toBe(PRIMARY);

    exhaustPrimary();

    expect(connections[1].url).toBe(BACKUP);
    // The abandoned socket was closed, so it cannot reconnect behind its
    // replacement.
    expect(sockets[0].disconnects).toBe(1);
  });

  it("rejoins the room on the backup", () => {
    mountWithBackup();

    exhaustPrimary();
    goOnline();

    expect(sentOn("join-room")).toEqual([
      { roomId: "room1", userId: ME, userTag: "Ada" },
    ]);
  });

  it("rotates back to the primary on the next failure", () => {
    // Both servers down in turn: the loop alternates rather than parking on the
    // backup forever, so recovery of either is picked up.
    mountWithBackup();

    exhaustPrimary();
    exhaustPrimary();

    expect(connections.map((connection) => connection.url)).toEqual([
      PRIMARY,
      BACKUP,
      PRIMARY,
    ]);
  });

  it("keeps retrying one server when no backup is configured", () => {
    // The historical behaviour: without anywhere to go, the client retries the
    // single server rather than cycling to a URL that does not exist.
    mountInRoom();

    exhaustPrimary();
    exhaustPrimary();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].disconnects).toBe(0);
  });

  it("does not re-run the join handshake for a rotation", () => {
    /*
     * The one-time centring and the roster memory belong to the room, not to
     * the connection: a failover replays `join-room` on the new server but must
     * not reset who the host is, or the view would jump again.
     */
    const onHostCursor = vi.fn();
    process.env.NEXT_PUBLIC_SOCKET_URL_BACKUP = BACKUP;
    mountInRoom("room1", { onHostCursor });
    goOnline();

    roster({ id: "host", tag: "Ada" }, { id: ME, tag: "Me" });
    deliver("cursor-position", { userId: "host", x: 3, y: 4, tag: "Ada" });
    expect(onHostCursor).toHaveBeenCalledTimes(1);

    exhaustPrimary();
    expect(connections).toHaveLength(2);

    // The new connection carries the same room; the handshake state survived.
    expect(connections[1].query).toMatchObject({ roomId: "room1" });
  });
});

/** The roster message, which is also the room's only departure notice. */
const roster = (...users: Array<{ id: string; tag?: string }>) =>
  deliver("active-users", { users });

describe("losing the connection", () => {
  it("forgets everyone, including what they were part-way through drawing", () => {
    // Nothing survives the gap: the room moves on without this client, and a
    // cursor with a name on it reads as somebody who is still there.
    mountInRoom();
    goOnline();
    roster({ id: ME, tag: "Ada" }, { id: "p1", tag: "Bo" });
    deliver("cursor-position", { userId: "p1", x: 5, y: 6, tag: "Bo" });
    deliver("shape-in-progress", { userId: "p1", shape: wireShape("s1") });

    deliver("disconnect");

    expect(text("connected")).toBe("false");
    expect(text("roster")).toBe("");
    expect(text("cursors")).toBe("");
    expect(text("drawing")).toBe("");
  });

  it("goes offline with a word about why when no server answers", () => {
    // Expected in development, where the socket server often is not running: the
    // UI says "Offline" and the canvas still works, so this is a warning and not
    // a throw out of a socket handler.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountInRoom();
    goOnline();

    deliver("connect_error", new Error("ECONNREFUSED"));

    expect(text("connected")).toBe("false");
    expect(String(warn.mock.calls[0][0])).toContain(connections[0].url);
    expect(warn.mock.calls[0][1]).toBe("ECONNREFUSED");
  });
});

describe("the roster", () => {
  it("shows everyone the server lists", () => {
    mountInRoom();
    goOnline();

    roster({ id: ME, tag: "Ada" }, { id: "p1", tag: "Bo" });

    expect(text("roster")).toBe("Ada, Bo");
  });

  it("reads a message with no roster in it as an empty room", () => {
    mountInRoom();
    goOnline();
    roster({ id: ME, tag: "Ada" });

    deliver("active-users", {});

    expect(text("roster")).toBe("");
  });

  it("relabels a cursor when its owner renames", () => {
    // The roster is authoritative about names, and a peer who renamed while
    // holding still would otherwise keep their old label until they moved.
    mountInRoom();
    goOnline();
    roster({ id: "p1", tag: "Bo" });
    deliver("cursor-position", { userId: "p1", x: 5, y: 6, tag: "Bo" });

    roster({ id: "p1", tag: "Robert" });

    expect(text("cursors")).toBe("p1:Robert@5,6");
  });

  it("leaves the cursors alone when the roster says nothing new", () => {
    // The server re-sends the roster on every join, rename and departure, so a
    // new cursor map each time repaints the whole overlay for nothing.
    mountInRoom();
    goOnline();
    roster({ id: "p1", tag: "Bo" });
    deliver("cursor-position", { userId: "p1", x: 5, y: 6, tag: "Bo" });
    const updates = cursorUpdates;

    roster({ id: "p1", tag: "Bo" });

    expect(cursorUpdates).toBe(updates);
  });

  it("keeps a cursor whose roster row arrived with no name on it", () => {
    // A nameless row is a garbled message, not an instruction to unlabel a
    // cursor that has a perfectly good name already.
    mountInRoom();
    goOnline();
    roster({ id: "p1", tag: "Bo" });
    deliver("cursor-position", { userId: "p1", x: 5, y: 6, tag: "Bo" });

    roster({ id: "p1" });

    expect(text("cursors")).toBe("p1:Bo@5,6");
  });

  it("shows your own new name at once, without waiting for the echo", () => {
    // The server's echo only comes back if there is a room at all — on the local
    // canvas there is no socket — so your own row is patched here as well.
    mountInRoom();
    goOnline();
    roster({ id: ME, tag: "Ada" }, { id: "p1", tag: "Bo" });

    act(() => {
      api.setUserName("Grace");
    });

    expect(text("roster")).toBe("Grace, Bo");
  });
});

/**
 * The server sends no departure event: a peer who closes their tab is simply
 * absent from the next roster. So the roster message is where leaving is
 * noticed, and anything of theirs still on this canvas has to go with it.
 */
describe("somebody leaving", () => {
  it("takes their half-drawn shape with them", () => {
    // The shape carries no timestamp and nothing else clears it, so without this
    // it sits on everyone else's canvas until each of them reconnects.
    mountInRoom();
    goOnline();
    roster({ id: ME, tag: "Ada" }, { id: "p1", tag: "Bo" });
    deliver("shape-in-progress", { userId: "p1", shape: wireShape("s1") });
    expect(text("drawing")).toBe("p1");

    roster({ id: ME, tag: "Ada" });

    expect(text("drawing")).toBe("");
  });

  it("takes their cursor too, rather than leaving it to go stale", () => {
    // The sweep would get it in ten seconds; a labelled cursor sitting still for
    // ten seconds is somebody who looks like they are watching you.
    mountInRoom();
    goOnline();
    roster({ id: ME, tag: "Ada" }, { id: "p1", tag: "Bo" });
    deliver("cursor-position", { userId: "p1", x: 5, y: 6, tag: "Bo" });

    roster({ id: ME, tag: "Ada" });

    expect(text("cursors")).toBe("");
  });

  it("leaves everyone who is still here exactly as they were", () => {
    // Pruning on every roster message is only safe if it prunes precisely the
    // people the roster no longer lists.
    mountInRoom();
    goOnline();
    roster({ id: "p1", tag: "Bo" }, { id: "p2", tag: "Cy" });
    deliver("shape-in-progress", { userId: "p1", shape: wireShape("s1") });
    deliver("shape-in-progress", { userId: "p2", shape: wireShape("s2") });
    deliver("cursor-position", { userId: "p1", x: 1, y: 2, tag: "Bo" });

    roster({ id: "p1", tag: "Bo" });

    expect(text("drawing")).toBe("p1");
    expect(text("cursors")).toBe("p1:Bo@1,2");
  });

  it("hands back the same shapes when nobody has gone", () => {
    /*
     * By identity, because this map is a dependency of the context value: a new
     * object on every roster echo — one per join, rename and departure in the
     * room — re-renders every consumer and repaints the canvas.
     */
    mountInRoom();
    goOnline();
    roster({ id: "p1", tag: "Bo" });
    deliver("shape-in-progress", { userId: "p1", shape: wireShape("s1") });
    const before = api.remoteInProgress;

    roster({ id: "p1", tag: "Bo" }, { id: "p2", tag: "Cy" });

    expect(api.remoteInProgress).toBe(before);
  });
});

describe("hydrating from the room", () => {
  it("gives a joiner the room's scene as its initial scene", () => {
    // Which is not the same as an update: the canvas takes an initial scene as
    // the state it started in, and that is only true once, on the way in.
    const onInitialScene = vi.fn();
    const onScene = vi.fn();
    mountInRoom("room1", { onInitialScene, onScene });
    goOnline();

    deliver("canvas-state-sync", {
      userId: "p1",
      shapes: [wireShape("s1"), wireShape("s2")],
    });

    expect(ids(onInitialScene.mock.calls[0][0])).toEqual(["s1", "s2"]);
    expect(onScene).not.toHaveBeenCalled();
  });

  it("falls back to the ordinary scene handler when there is no initial one", () => {
    const onScene = vi.fn();
    mountInRoom("room1", { onScene });
    goOnline();

    deliver("canvas-state-sync", { userId: "p1", shapes: [wireShape("s1")] });

    expect(ids(onScene.mock.calls[0][0])).toEqual(["s1"]);
  });

  it("ignores the scene it sent itself", () => {
    // The server addresses this to one socket, but a second tab sharing the
    // stored id would otherwise overwrite live work with an older scene.
    const onInitialScene = vi.fn();
    mountInRoom("room1", { onInitialScene });
    goOnline();

    deliver("canvas-state-sync", { userId: ME, shapes: [wireShape("s1")] });

    expect(onInitialScene).not.toHaveBeenCalled();
  });

  it("keeps only what restores to an element", () => {
    // This is the room's whole scene arriving from a peer, which is as untrusted
    // as any other message on the wire.
    const onInitialScene = vi.fn();
    mountInRoom("room1", { onInitialScene });
    goOnline();

    deliver("canvas-state-sync", {
      userId: "p1",
      shapes: [wireShape("s1"), { tool: "Nonsense" }, null, "s3"],
    });

    expect(ids(onInitialScene.mock.calls[0][0])).toEqual(["s1"]);
  });

  it("answers a newcomer's request with the scene it is holding", () => {
    const scene = [
      createElement("Square", { id: "s1", x: 0, y: 0, width: 10, height: 10 })!,
    ];
    mountInRoom("room1", { getScene: () => scene });
    goOnline();

    deliver("request-canvas-state", { targetUserId: "p1" });

    expect(sentOn("canvas-state-response")).toEqual([
      { roomId: "room1", userId: ME, targetUserId: "p1", shapes: scene },
    ]);
  });

  it("answers with an empty scene rather than not answering", () => {
    // The newcomer is waiting on this reply to finish hydrating, and a board
    // with nothing on it is a perfectly ordinary answer.
    mountInRoom();
    goOnline();

    deliver("request-canvas-state", { targetUserId: "p1" });

    expect(sentOn("canvas-state-response")[0]).toMatchObject({ shapes: [] });
  });
});

describe("other people's cursors", () => {
  it("puts a cursor where its owner says, under their name", () => {
    mountInRoom();
    goOnline();

    deliver("cursor-position", { userId: "p1", x: 12, y: 34, tag: "Bo" });

    expect(text("cursors")).toBe("p1:Bo@12,34");
  });

  it("labels a cursor that arrived without a name", () => {
    // An unlabelled cursor is a pointer with nobody attached to it.
    mountInRoom();
    goOnline();

    deliver("cursor-position", { userId: "p1", x: 1, y: 2 });

    expect(text("cursors")).toBe("p1:User@1,2");
  });

  it("ignores its own cursor coming back", () => {
    // Otherwise you draw a second cursor chasing your own, a round trip behind.
    mountInRoom();
    goOnline();

    deliver("cursor-position", { userId: ME, x: 1, y: 2, tag: "Ada" });

    expect(text("cursors")).toBe("");
  });

  it("ignores a message with no position in it", () => {
    // A cursor at NaN is drawn nowhere and takes the rest of the overlay's draw
    // calls with it, so the coordinates are checked and not merely defaulted.
    mountInRoom();
    goOnline();

    deliver("cursor-position", { userId: "p1", tag: "Bo" });
    deliver("cursor-position", { userId: "p1", x: "12", y: 34, tag: "Bo" });

    expect(text("cursors")).toBe("");
  });

  it("ignores a message with nobody to attribute it to", () => {
    mountInRoom();
    goOnline();

    deliver("cursor-position", { x: 1, y: 2, tag: "Bo" });

    expect(text("cursors")).toBe("");
  });

  it("forgets a cursor that has not moved for ten seconds", () => {
    // Someone who switched tabs has not left — the roster still lists them — but
    // their pointer is not where they are looking either, and a pile of labels
    // over abandoned positions is what the board looked like before this.
    mountInRoom();
    goOnline();
    roster({ id: "p1", tag: "Bo" });
    deliver("cursor-position", { userId: "p1", x: 1, y: 2, tag: "Bo" });

    // The sweep runs every five seconds; the third pass is the first one past
    // the ten-second cutoff.
    advance(15_000);

    expect(text("cursors")).toBe("");
  });

  it("keeps one that moved a moment ago", () => {
    mountInRoom();
    goOnline();
    deliver("cursor-position", { userId: "p1", x: 1, y: 2, tag: "Bo" });

    advance(5_000);

    expect(text("cursors")).toBe("p1:Bo@1,2");
  });

  it("hands back the same cursors when none of them went stale", () => {
    // The sweep runs for as long as the board is open, so a new map on every
    // pass would repaint the overlay every five seconds for nothing.
    mountInRoom();
    goOnline();
    deliver("cursor-position", { userId: "p1", x: 1, y: 2, tag: "Bo" });
    const updates = cursorUpdates;

    advance(10_000);

    expect(cursorUpdates).toBe(updates);
  });
});

/**
 * The join handshake. The roster is ordered by when each person joined, so its
 * first name is the room's host: the person whose pointer a newcomer centres on
 * and who re-announces that pointer when somebody joins behind them.
 */
describe("starting where the host is", () => {
  it("centres a joiner on the first pointer from the host", () => {
    const onHostCursor = vi.fn();
    mountInRoom("room1", { onHostCursor });
    goOnline();

    roster({ id: "host", tag: "Ada" }, { id: ME, tag: "Me" });
    deliver("cursor-position", { userId: "host", x: 12, y: 34, tag: "Ada" });

    expect(onHostCursor).toHaveBeenCalledWith({ x: 12, y: 34 });
  });

  it("ignores a pointer from anyone who is not the host", () => {
    const onHostCursor = vi.fn();
    mountInRoom("room1", { onHostCursor });
    goOnline();

    roster(
      { id: "host", tag: "Ada" },
      { id: "other", tag: "Bo" },
      { id: ME, tag: "Me" },
    );
    deliver("cursor-position", { userId: "other", x: 5, y: 6, tag: "Bo" });

    expect(onHostCursor).not.toHaveBeenCalled();

    deliver("cursor-position", { userId: "host", x: 7, y: 8, tag: "Ada" });

    expect(onHostCursor).toHaveBeenCalledWith({ x: 7, y: 8 });
  });

  it("still centres when the host's pointer arrives before the roster", () => {
    // The two messages can leave different instances and arrive in either order,
    // which is why the last pointer is kept rather than only looked at live.
    const onHostCursor = vi.fn();
    mountInRoom("room1", { onHostCursor });
    goOnline();

    deliver("cursor-position", { userId: "host", x: 1, y: 2, tag: "Ada" });
    roster({ id: "host", tag: "Ada" }, { id: ME, tag: "Me" });

    expect(onHostCursor).toHaveBeenCalledWith({ x: 1, y: 2 });
  });

  it("centres only once, however much the host moves afterwards", () => {
    const onHostCursor = vi.fn();
    mountInRoom("room1", { onHostCursor });
    goOnline();

    roster({ id: "host", tag: "Ada" }, { id: ME, tag: "Me" });
    deliver("cursor-position", { userId: "host", x: 1, y: 1 });
    deliver("cursor-position", { userId: "host", x: 2, y: 2 });

    expect(onHostCursor).toHaveBeenCalledTimes(1);
  });

  it("does not centre the host on itself", () => {
    // Alone at the head of the roster there is nobody ahead to follow.
    const onHostCursor = vi.fn();
    mountInRoom("room1", { onHostCursor });
    goOnline();

    roster({ id: ME, tag: "Me" }, { id: "p1", tag: "Bo" });
    deliver("cursor-position", { userId: "p1", x: 5, y: 5, tag: "Bo" });

    expect(onHostCursor).not.toHaveBeenCalled();
  });

  it("has the host re-announce its pointer when somebody new appears", () => {
    // A newcomer cannot centre on a pointer that has not moved since they
    // arrived, and the room is idle exactly at that moment. The ordinary cursor
    // throttle would swallow a plain re-send, so the announcement is its own,
    // reliable message.
    mountInRoom();
    goOnline();
    act(() => api.sendCursor({ x: 9, y: 9 }));

    roster({ id: ME, tag: "Me" });
    expect(sentOn("announce-cursor")).toEqual([]);

    roster({ id: ME, tag: "Me" }, { id: "p1", tag: "Bo" });

    expect(sentOn("announce-cursor")).toEqual([
      { roomId: "room1", userId: ME, x: 9, y: 9, tag: "Ada" },
    ]);
  });

  it("a peer who is not the host does not announce", () => {
    mountInRoom();
    goOnline();
    act(() => api.sendCursor({ x: 9, y: 9 }));

    roster({ id: "host", tag: "Ada" }, { id: ME, tag: "Me" });
    roster(
      { id: "host", tag: "Ada" },
      { id: ME, tag: "Me" },
      { id: "p2", tag: "Cy" },
    );

    expect(sentOn("announce-cursor")).toEqual([]);
  });

  it("has nothing to announce before its pointer has been on the canvas", () => {
    mountInRoom();
    goOnline();

    roster({ id: ME, tag: "Me" });
    roster({ id: ME, tag: "Me" }, { id: "p1", tag: "Bo" });

    expect(sentOn("announce-cursor")).toEqual([]);
  });
});

describe("what other people are drawing", () => {
  it("shows a peer's shape while they are still drawing it", () => {
    // Marked in progress on arrival whatever the sender claimed: that flag is
    // what keeps it out of the scene, the undo history and the next save.
    mountInRoom();
    goOnline();

    deliver("shape-in-progress", {
      userId: "p1",
      shape: wireShape("s1", { isInProgress: false }),
    });

    expect(text("drawing")).toBe("p1");
    expect(api.remoteInProgress.p1).toMatchObject({
      id: "s1",
      isInProgress: true,
    });
  });

  it("keeps one shape per person, not one per frame", () => {
    // Each message is the whole shape as it stands, so the newest replaces the
    // one before it rather than accumulating a stroke's worth of ghosts.
    mountInRoom();
    goOnline();

    deliver("shape-in-progress", { userId: "p1", shape: wireShape("s1") });
    deliver("shape-in-progress", {
      userId: "p1",
      shape: wireShape("s1", { width: 80 }),
    });

    expect(Object.keys(api.remoteInProgress)).toEqual(["p1"]);
    expect(api.remoteInProgress.p1).toMatchObject({ width: 80 });
  });

  it("clears the shape when what arrives is not one", () => {
    mountInRoom();
    goOnline();
    deliver("shape-in-progress", { userId: "p1", shape: wireShape("s1") });

    deliver("shape-in-progress", { userId: "p1", shape: null });

    expect(text("drawing")).toBe("");
  });

  it("appends a freehand increment to the copy it already holds", () => {
    // A long stroke arrives in slices; holding the whole thing on screen costs
    // the sender the whole stroke again on every tick.
    mountInRoom();
    goOnline();

    deliver("shape-in-progress", {
      userId: "p1",
      shape: { id: "f1", tool: "Freehand", points: [0, 0, 10, 10] },
    });
    deliver("shape-in-progress", {
      userId: "p1",
      shape: { id: "f1", tool: "Freehand", points: [20, 5] },
      pointsOffset: 4,
    });

    const stroke = api.remoteInProgress.p1 as {
      points: number[];
      x: number;
      y: number;
      width: number;
      height: number;
      isInProgress: boolean;
    };
    expect(stroke.points).toEqual([0, 0, 10, 10, 20, 5]);
    // The increment described only its own points, so the box the renderer culls
    // on has to grow to cover the appended tail.
    expect(stroke).toMatchObject({ x: 0, y: 0, width: 20, height: 10 });
    expect(stroke.isInProgress).toBe(true);
  });

  it("ignores an increment whose base it does not hold", () => {
    // The base snapshot travelled over a volatile send and was dropped. Applying
    // the tail to nothing would draw a fragment; the next full snapshot (or the
    // committed element) is authoritative.
    mountInRoom();
    goOnline();
    deliver("shape-in-progress", { userId: "p1", shape: wireShape("s1") });

    deliver("shape-in-progress", {
      userId: "p1",
      shape: { id: "f1", tool: "Freehand", points: [20, 5] },
      pointsOffset: 4,
    });

    expect(api.remoteInProgress.p1).toMatchObject({ id: "s1" });
  });

  it("ignores an increment for a stroke it has never seen", () => {
    mountInRoom();
    goOnline();

    deliver("shape-in-progress", {
      userId: "p1",
      shape: { id: "f1", tool: "Freehand", points: [20, 5] },
      pointsOffset: 4,
    });

    expect(text("drawing")).toBe("");
  });

  it("clears it when the peer says the stroke is over", () => {
    // The finished shape arrives separately as a canvas update; leaving the
    // in-progress copy up draws it twice, the staler one on top.
    mountInRoom();
    goOnline();
    deliver("shape-in-progress", { userId: "p1", shape: wireShape("s1") });

    deliver("drawing-state", { userId: "p1", isDrawing: false });

    expect(text("drawing")).toBe("");
  });

  it("leaves it up while they say they are still drawing", () => {
    mountInRoom();
    goOnline();
    deliver("shape-in-progress", { userId: "p1", shape: wireShape("s1") });

    deliver("drawing-state", { userId: "p1", isDrawing: true });

    expect(text("drawing")).toBe("p1");
  });

  it("ignores both of its own drawing messages", () => {
    // Your own in-progress shape is already on your canvas, drawn from the
    // gesture itself; the copy from the wire would trail it by a round trip.
    mountInRoom();
    goOnline();

    deliver("shape-in-progress", { userId: ME, shape: wireShape("s1") });
    deliver("drawing-state", { userId: ME, isDrawing: false });

    expect(text("drawing")).toBe("");
  });

  it("ignores a shape with nobody to attribute it to", () => {
    mountInRoom();
    goOnline();

    deliver("shape-in-progress", { shape: wireShape("s1") });

    expect(text("drawing")).toBe("");
  });
});

describe("updates from other people", () => {
  /** Mounts with all three canvas handlers recorded and the socket already up. */
  const inRoom = () => {
    const handlers = {
      onScene: vi.fn(),
      onElements: vi.fn(),
      onDeletions: vi.fn(),
    };
    mountInRoom("room1", handlers);
    goOnline();
    return handlers;
  };

  it("replaces the whole scene on a full update", () => {
    const { onScene, onElements } = inRoom();

    deliver("canvas-update", {
      userId: "p1",
      shapes: [wireShape("s1")],
      fullUpdate: true,
    });

    expect(ids(onScene.mock.calls[0][0])).toEqual(["s1"]);
    expect(onElements).not.toHaveBeenCalled();
  });

  it("merges the elements of a partial update", () => {
    // The ordinary case: the one shape somebody moved, not the four hundred
    // others that did not.
    const { onScene, onElements } = inRoom();

    deliver("canvas-update", {
      userId: "p1",
      shapes: [wireShape("s1")],
      isPartial: true,
    });

    expect(ids(onElements.mock.calls[0][0])).toEqual(["s1"]);
    expect(onScene).not.toHaveBeenCalled();
  });

  it("says nothing when a partial update restored nothing", () => {
    // A message whose elements were all rejected is not an instruction to merge
    // an empty list, which the canvas would treat as a change and pass on.
    const { onElements } = inRoom();

    deliver("canvas-update", { userId: "p1", shapes: [{ tool: "Nonsense" }] });

    expect(onElements).not.toHaveBeenCalled();
  });

  it("applies a deletion", () => {
    const { onDeletions } = inRoom();

    deliver("canvas-update", { userId: "p1", deletedShapeIds: ["s1", "s2"] });

    expect(onDeletions).toHaveBeenCalledWith(["s1", "s2"]);
  });

  it("keeps only the ids that are ids", () => {
    // A number would delete nothing and an object would delete nothing, but both
    // would be passed to the canvas as though they named something.
    const { onDeletions } = inRoom();

    deliver("canvas-update", {
      userId: "p1",
      deletedShapeIds: ["s1", 7, null, { id: "s2" }],
    });

    expect(onDeletions).toHaveBeenCalledWith(["s1"]);
  });

  it("says nothing when a deletion named nothing usable", () => {
    const { onDeletions } = inRoom();

    deliver("canvas-update", { userId: "p1", deletedShapeIds: [7] });

    expect(onDeletions).not.toHaveBeenCalled();
  });

  it("ignores its own update coming back", () => {
    // The server does not echo to the sender, but a second tab sharing the
    // stored id does, and re-applying your own change is how a scene starts
    // arguing with itself.
    const { onScene } = inRoom();

    deliver("canvas-update", {
      userId: ME,
      shapes: [wireShape("s1")],
      fullUpdate: true,
    });

    expect(onScene).not.toHaveBeenCalled();
  });

  it("does nothing with a message that carries neither", () => {
    const { onScene, onElements, onDeletions } = inRoom();

    deliver("canvas-update", { userId: "p1" });

    expect(onScene).not.toHaveBeenCalled();
    expect(onElements).not.toHaveBeenCalled();
    expect(onDeletions).not.toHaveBeenCalled();
  });
});

/** Reads the durability answer the way `Canvas.tsx` does: by object identity. */
const PersistenceProbe = () => {
  const { scenePersistence } = useCollaborationContext();
  useEffect(() => {
    announcements += 1;
  }, [scenePersistence]);
  return (
    <p data-testid="persistence">
      {`${scenePersistence.durable} / ${scenePersistence.reason}`}
    </p>
  );
};

const mountWatchingDurability = (roomId = "room1") =>
  render(
    <CollaborationContextProvider roomId={roomId}>
      <PersistenceProbe />
    </CollaborationContextProvider>,
  );

/** What the socket server sends after each attempt to write the scene. */
const serverReports = (payload: unknown) =>
  deliver("scene-persistence", payload);

describe("durability reporting", () => {
  it("knows nothing until the server has attempted a write", () => {
    // Which is not the same as "yes": a room nobody has edited has had no write,
    // and a deployment with no store of record never reports at all.
    mountWatchingDurability();

    expect(text("persistence")).toBe("null / null");
  });

  it("adopts what the server says, in the server's own vocabulary", () => {
    mountWatchingDurability();

    serverReports({ roomId: "room1", durable: false, reason: "deleted" });

    expect(text("persistence")).toBe("false / deleted");
  });

  it("says nothing new when the answer has not changed", () => {
    // The point of the whole arrangement: the server reports after every write, so
    // roughly every three seconds while somebody draws, and a toast on each of
    // those would be its own outage.
    mountWatchingDurability();
    expect(announcements).toBe(1); // the mount

    serverReports({ durable: false, reason: "unreachable" });
    serverReports({ durable: false, reason: "unreachable" });
    serverReports({ durable: false, reason: "unreachable" });

    expect(announcements).toBe(2);
  });

  it("announces a recovery, and each real change", () => {
    mountWatchingDurability();

    serverReports({ durable: false, reason: "unreachable" });
    serverReports({ durable: true, reason: null });

    expect(text("persistence")).toBe("true / null");
    expect(announcements).toBe(3);
  });

  it("drops a reason it does not recognise, keeping the bad news", () => {
    // A newer server, or a garbled payload. The generic message is still right;
    // claiming the board was deleted on the strength of an unknown string is not.
    mountWatchingDurability();

    serverReports({ durable: false, reason: "kaput" });

    expect(text("persistence")).toBe("false / null");
  });

  it("reads a payload with nothing in it as a failure", () => {
    // Deliberately the pessimistic direction: the server always sends `durable`,
    // so a message without it is a bug, and the safe reading of a bug about
    // whether work is being kept is that it is not.
    mountWatchingDurability();

    serverReports({});

    expect(text("persistence")).toBe("false / null");
  });

  it("keeps the answer through a reconnect, unlike the roster", () => {
    // A deleted board is still deleted, and losing the connection is reported on
    // its own; clearing this would flash "saving again" over a board that is not.
    mountWatchingDurability();
    serverReports({ durable: false, reason: "deleted" });

    deliver("disconnect");

    expect(text("persistence")).toBe("false / deleted");
  });

  it("forgets the last room's answer on the way into a new one", () => {
    // Same provider, different board: a room that was fine says nothing about the
    // one that replaced it, and a deleted board must not follow you.
    const { rerender } = mountWatchingDurability("room1");
    serverReports({ durable: false, reason: "deleted" });

    rerender(
      <CollaborationContextProvider roomId="room2">
        <PersistenceProbe />
      </CollaborationContextProvider>,
    );

    expect(text("persistence")).toBe("null / null");
  });
});

describe("what this client sends", () => {
  const square = (id: string) =>
    createElement("Square", { id, x: 0, y: 0, width: 10, height: 10 })!;

  it("sends nothing before the socket is up", () => {
    // socket.io drops what is emitted while it is still connecting, so a scene
    // sent a moment too early is a scene nobody else ever sees.
    mountInRoom();

    act(() => {
      api.sendCursor({ x: 1, y: 2 });
      api.sendScene([square("s1")]);
    });

    expect(socket().sent).toEqual([]);
  });

  it("sends nothing at all on the local canvas", () => {
    // The canvas calls these on every pointer move and every commit whether or
    // not there is a room, because it does not know which it is on.
    mountInRoom(null);

    act(() => {
      api.sendCursor({ x: 1, y: 2 });
      api.sendScene([square("s1")]);
      api.sendTransientElements([square("s2")]);
      api.sendPendingElement(null);
    });

    expect(sockets).toHaveLength(0);
  });

  it("stamps the room and the sender onto every message", () => {
    // The server routes on the room and attributes on the sender; a message
    // missing either is dropped without a word.
    mountInRoom();
    goOnline();

    act(() => {
      api.sendCursor({ x: 3, y: 4 });
    });

    expect(sentOn("cursor-position")[0]).toEqual({
      roomId: "room1",
      userId: ME,
      x: 3,
      y: 4,
      tag: "Ada",
    });
  });

  it("throttles the cursor to one message every 50ms", () => {
    // A pointer moves far faster than that, and every message is fanned out to
    // everybody else in the room.
    mountInRoom();
    goOnline();

    act(() => {
      api.sendCursor({ x: 1, y: 1 });
      api.sendCursor({ x: 2, y: 2 });
    });
    advance(50);
    act(() => {
      api.sendCursor({ x: 3, y: 3 });
    });

    expect(sentOn("cursor-position").map((message) => message.x)).toEqual([1, 3]);
  });

  it("sends the whole scene as a full update", () => {
    // The receiver replaces its scene on this flag, so it is the difference
    // between "here is everything" and "here is what changed".
    mountInRoom();
    goOnline();
    const scene = [square("s1")];

    act(() => {
      api.sendScene(scene);
    });

    expect(sentOn("canvas-update")[0]).toMatchObject({
      shapes: scene,
      fullUpdate: true,
    });
  });

  it("sends a handful of changed elements as a partial one", () => {
    mountInRoom();
    goOnline();

    act(() => {
      api.sendElements([square("s1")]);
    });

    expect(sentOn("canvas-update")[0]).toMatchObject({ isPartial: true });
    expect(sentOn("canvas-update")[0].fullUpdate).toBeUndefined();
  });

  it("sends a deletion as ids, without the shapes", () => {
    mountInRoom();
    goOnline();

    act(() => {
      api.sendDeletions(["s1", "s2"]);
    });

    expect(sentOn("canvas-update")[0]).toMatchObject({
      deletedShapeIds: ["s1", "s2"],
      isPartial: true,
    });
  });

  it("says nothing when there is nothing to say", () => {
    // All three are called from paths that often change nothing, and an empty
    // update still costs the server a fan-out to everybody in the room.
    mountInRoom();
    goOnline();

    act(() => {
      api.sendElements([]);
      api.sendTransientElements([]);
      api.sendDeletions([]);
    });

    expect(sentOn("canvas-update")).toEqual([]);
  });

  it("throttles the in-progress shape to one message every 40ms", () => {
    // Tighter than the cursor: this one is a whole shape, and it is sent for as
    // long as the stroke lasts.
    mountInRoom();
    goOnline();

    act(() => {
      api.sendPendingElement(square("s1"));
      api.sendPendingElement(square("s1"));
    });
    advance(40);
    act(() => {
      api.sendPendingElement(square("s1"));
    });

    expect(sentOn("shape-in-progress")).toHaveLength(2);
    expect(sentOn("shape-in-progress")[0].shape).toMatchObject({
      id: "s1",
      isInProgress: true,
    });
  });

  it("says the stroke is over, and lets the next one start at once", () => {
    /*
     * The end of a stroke resets the throttle as well as announcing itself. A
     * quick tap that starts within 40ms of the last stroke would otherwise have
     * its only frame swallowed, and nobody would see it being drawn at all.
     */
    mountInRoom();
    goOnline();
    act(() => {
      api.sendPendingElement(square("s1"));
    });

    act(() => {
      api.sendPendingElement(null);
    });
    act(() => {
      api.sendPendingElement(square("s2"));
    });

    expect(sentOn("drawing-state")).toEqual([
      { roomId: "room1", userId: ME, isDrawing: false },
    ]);
    expect(sentOn("shape-in-progress")).toHaveLength(2);
  });

  it("marks cursors and in-progress previews volatile, so a slow link drops them", () => {
    // A cursor position or a half-drawn stroke from a moment ago is worth less
    // than the messages stuck behind it on a backed-up socket; queuing it would
    // delay everything else. State changes are not droppable.
    mountInRoom();
    goOnline();

    act(() => {
      api.sendCursor({ x: 1, y: 1 });
      api.sendPendingElement(square("s1"));
    });
    act(() => {
      api.sendPendingElement(null);
    });

    const messages = socket().sent;
    expect(messages.find((m) => m.event === "cursor-position")?.volatile).toBe(true);
    expect(messages.find((m) => m.event === "shape-in-progress")?.volatile).toBe(true);
    expect(messages.find((m) => m.event === "drawing-state")?.volatile).toBeUndefined();
  });

  it("sends a freehand stroke whole first, then only the new points", () => {
    /*
     * The stroke grew by two numbers a move but was sent whole: a long scribble
     * paid for the entire stroke again every 40ms.
     */
    mountInRoom();
    goOnline();
    const stroke = (points: number[]) =>
      createElement("Freehand", { id: "f1", points })!;

    act(() => {
      api.sendPendingElement(stroke([0, 0, 10, 10]));
    });
    advance(PENDING_THROTTLE_MS);
    act(() => {
      api.sendPendingElement(stroke([0, 0, 10, 10, 20, 5, 30, 8]));
    });

    expect(sentOn("shape-in-progress")).toHaveLength(2);
    const [full, delta] = sentOn("shape-in-progress");
    expect(full.pointsOffset).toBeUndefined();
    expect((full.shape as { points: number[] }).points).toEqual([0, 0, 10, 10]);
    // The offset is how many flat values the receiver should already hold:
    // the first stroke sent had two points, i.e. four values.
    expect(delta.pointsOffset).toBe(4);
    expect((delta.shape as { points: number[] }).points).toEqual([20, 5, 30, 8]);
  });

  it("re-anchors a long freehand stroke with a full snapshot every so often", () => {
    // A delta dropped by a volatile send would otherwise leave a permanent hole
    // in the preview; the periodic snapshot bounds what a drop costs.
    mountInRoom();
    goOnline();
    const stroke = (points: number[]) =>
      createElement("Freehand", { id: "f1", points })!;

    act(() => {
      api.sendPendingElement(stroke([0, 0]));
    });
    for (let i = 1; i <= FREEHAND_FULL_EVERY + 1; i += 1) {
      advance(PENDING_THROTTLE_MS);
      act(() => {
        api.sendPendingElement(stroke([0, 0, ...Array.from({ length: i * 2 }, (_, j) => j)]));
      });
    }

    const sends = sentOn("shape-in-progress");
    expect(sends).toHaveLength(FREEHAND_FULL_EVERY + 2);
    // The last one is a full snapshot again, not a delta.
    expect(sends.at(-1)!.pointsOffset).toBeUndefined();
    expect(
      (sends.at(-1)!.shape as { points: number[] }).points,
    ).toHaveLength(2 + (FREEHAND_FULL_EVERY + 1) * 2);
  });

  it("folds a burst of incremental updates into one message, first going out at once", () => {
    // A drag applies on every pointer move; folding the rest of each frame's
    // worth into the trailing send is what keeps a 120Hz pointer from being a
    // 120-message-per-second room.
    mountInRoom();
    goOnline();

    act(() => {
      api.sendElements([square("s1")]);
      api.sendElements([square("s2")]);
      api.sendElements([square("s3")]);
    });

    expect(sentOn("canvas-update")).toHaveLength(1);
    const first = sentOn("canvas-update")[0] as { shapes: unknown[] };
    expect(
      (first.shapes as Array<{ id: string }>).map((s) => s.id),
    ).toEqual(["s1"]);

    advance(ELEMENT_COALESCE_MS + 1);
    expect(sentOn("canvas-update")).toHaveLength(2);
    const second = sentOn("canvas-update")[1] as { shapes: unknown[] };
    expect(
      (second.shapes as Array<{ id: string }>).map((s) => s.id),
    ).toEqual(["s2", "s3"]);
  });

  it("carries the latest state of an element touched twice inside a window", () => {
    mountInRoom();
    goOnline();
    const moved = (x: number) =>
      createElement("Square", { id: "s1", x, y: 0, width: 10, height: 10 })!;

    act(() => {
      api.sendElements([moved(0)]);
      api.sendElements([moved(40)]);
    });
    advance(ELEMENT_COALESCE_MS + 1);

    const trailing = sentOn("canvas-update").at(-1)! as {
      shapes: Array<{ id: string; x: number }>;
    };
    expect(trailing.shapes).toHaveLength(1);
    expect(trailing.shapes[0].id).toBe("s1");
    expect(trailing.shapes[0].x).toBe(40);
  });

  it("drops queued incremental updates when a full scene goes out", () => {
    // The full scene replaces everything a peer holds; re-applying a queued
    // element afterwards would put an older shape on top of it.
    mountInRoom();
    goOnline();

    act(() => {
      api.sendElements([square("s1")]);
      api.sendElements([square("s2")]);
      api.sendScene([square("s1"), square("s2"), square("s3")]);
    });
    advance(ELEMENT_COALESCE_MS + 1);

    const messages = sentOn("canvas-update") as Array<{
      shapes: unknown[];
      fullUpdate?: boolean;
    }>;
    expect(messages).toHaveLength(2);
    expect(
      (messages[0].shapes as Array<{ id: string }>).map((s) => s.id),
    ).toEqual(["s1"]);
    expect(messages[1].fullUpdate).toBe(true);
  });

  it("does not resurrect an element deleted while its update was queued", () => {
    mountInRoom();
    goOnline();

    act(() => {
      api.sendElements([square("s1")]);
      api.sendElements([square("s2")]);
      api.sendDeletions(["s2"]);
    });
    advance(ELEMENT_COALESCE_MS + 1);

    // The queue emptied, so only the leading update and the deletion were sent.
    const messages = sentOn("canvas-update") as Array<{
      shapes?: unknown[];
      deletedShapeIds?: unknown;
    }>;
    const withShapes = messages.filter((m) => m.shapes);
    expect(withShapes).toHaveLength(1);
    expect(
      messages.some(
        (m) => (m.deletedShapeIds as string[] | undefined)?.[0] === "s2",
      ),
    ).toBe(true);
  });

  it("sends a mid-gesture preview as a volatile partial", () => {
    // Movement is the same shape of problem as the cursor: a position the next
    // frame or the commit supersedes is worth less than the message behind it,
    // so it travels droppable and is marked as a preview for the server.
    mountInRoom();
    goOnline();

    act(() => {
      api.sendTransientElements([square("s1")]);
    });

    const [message] = socket().sent.filter(
      (m) => m.event === "canvas-update",
    );
    expect(message.volatile).toBe(true);
    expect(message.payload).toMatchObject({ isPartial: true, isTransient: true });
    expect(
      (message.payload.shapes as Array<{ id: string }>).map((s) => s.id),
    ).toEqual(["s1"]);
  });

  it("folds a burst of previews into one message, first going out at once", () => {
    // Same leading-edge-plus-window shape as a committed update, on its own
    // shorter window: the first frame of a drag must not wait to be seen.
    mountInRoom();
    goOnline();

    act(() => {
      api.sendTransientElements([square("s1")]);
      api.sendTransientElements([square("s2")]);
      api.sendTransientElements([square("s3")]);
    });

    const leading = socket().sent.filter((m) => m.event === "canvas-update");
    expect(leading).toHaveLength(1);
    expect(
      (leading[0].payload.shapes as Array<{ id: string }>).map((s) => s.id),
    ).toEqual(["s1"]);

    advance(TRANSIENT_COALESCE_MS + 1);

    const all = socket().sent.filter((m) => m.event === "canvas-update");
    expect(all).toHaveLength(2);
    expect(
      (all[1].payload.shapes as Array<{ id: string }>).map((s) => s.id),
    ).toEqual(["s2", "s3"]);
  });

  it("does not let a queued preview land after the commit that replaces it", () => {
    /*
     * Both channels share one connection, so a preview flushed a frame after the
     * commit would win the ordering and the shape would snap back to its
     * mid-drag position on release.
     */
    mountInRoom();
    goOnline();
    const moved = (x: number) =>
      createElement("Square", { id: "s1", x, y: 0, width: 10, height: 10 })!;

    act(() => {
      api.sendTransientElements([moved(0)]);
      api.sendTransientElements([moved(40)]);
      api.sendElements([moved(40)]);
    });
    advance(ELEMENT_COALESCE_MS + 1);

    const messages = socket().sent.filter((m) => m.event === "canvas-update");
    expect(messages).toHaveLength(2);
    expect(messages[0].volatile).toBe(true);
    // The last word is the reliable commit, not a leftover preview.
    expect(messages[1].volatile).toBeUndefined();
    expect(messages[1].payload.isTransient).toBeUndefined();
    expect((messages[1].payload.shapes as Array<{ x: number }>)[0].x).toBe(40);
  });

  it("drops queued previews when a full scene goes out", () => {
    mountInRoom();
    goOnline();

    act(() => {
      api.sendTransientElements([square("s1")]);
      api.sendTransientElements([square("s2")]);
      api.sendScene([square("s1"), square("s2")]);
    });
    advance(TRANSIENT_COALESCE_MS + 1);
    advance(ELEMENT_COALESCE_MS + 1);

    const messages = socket().sent.filter((m) => m.event === "canvas-update");
    expect(messages).toHaveLength(2);
    expect(messages[0].volatile).toBe(true);
    expect(messages[1].payload.fullUpdate).toBe(true);
  });

  it("never lets a preview resurrect an element that was deleted", () => {
    mountInRoom();
    goOnline();

    act(() => {
      api.sendTransientElements([square("s1")]);
      api.sendTransientElements([square("s2")]);
      api.sendDeletions(["s2"]);
    });
    advance(TRANSIENT_COALESCE_MS + 1);

    const previews = socket().sent.filter(
      (m) => m.event === "canvas-update" && m.payload.isTransient,
    );
    expect(previews).toHaveLength(1);
    expect(
      (previews[0].payload.shapes as Array<{ id: string }>).map((s) => s.id),
    ).toEqual(["s1"]);
  });

  it("forgets a queued preview when the board closes", () => {
    const { unmount } = mountInRoom();
    goOnline();
    act(() => {
      api.sendTransientElements([square("s1")]);
    });
    const sent = socket().sent.length;

    unmount();
    advance(TRANSIENT_COALESCE_MS + 1);

    expect(socket().sent).toHaveLength(sent);
  });

  it("tells the room when you rename yourself", () => {
    mountInRoom();
    goOnline();

    act(() => {
      api.setUserName("Grace");
    });

    expect(sentOn("update-user-name")).toEqual([
      { roomId: "room1", userId: ME, userTag: "Grace" },
    ]);
  });

  it("sends nothing when the rename held nothing usable", () => {
    // The caller keeps the field open on a false, and a blank tag that reached
    // the server would come back clamped to "Anonymous".
    mountInRoom();
    goOnline();

    let accepted = true;
    act(() => {
      accepted = api.setUserName("   ");
    });

    expect(accepted).toBe(false);
    expect(sentOn("update-user-name")).toEqual([]);
  });
});

describe("the share link", () => {
  const link = () => `${window.location.origin}/board/room1`;

  /** Copy, and wait for the clipboard, the way the button's handler does. */
  const copyLink = async () => {
    let result: boolean | undefined;
    await act(async () => {
      result = await api.copyShareableLink();
    });
    return result;
  };

  it("is the board's own address, ready before anyone asks", () => {
    // Built from the room the provider was given rather than from the URL bar, so
    // it is right on a board reached by any route.
    mountInRoom();

    expect(api.shareableLink).toBe(link());
  });

  it("copies it, says so, and stops saying so", async () => {
    // The confirmation is the only feedback a copy gets; it also has to go away
    // again, or the button reads as permanently pressed.
    mountInRoom();

    expect(await copyLink()).toBe(true);
    expect(copied).toEqual([link()]);
    expect(api.linkCopied).toBe(true);

    advance(2000);

    expect(api.linkCopied).toBe(false);
  });

  it("restarts the confirmation when you copy twice", async () => {
    // The first copy's timer would otherwise clear the second copy's message, and
    // the button would stop confirming halfway through.
    mountInRoom();
    await copyLink();

    advance(1500);
    await copyLink();
    advance(1500);

    expect(api.linkCopied).toBe(true);
  });

  it("admits it when the clipboard refuses", async () => {
    // It rejects when the document is not focused, among other reasons, and a
    // copy that silently did nothing is worse than one that says so.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withClipboard(() => Promise.reject(new Error("NotAllowedError")));
    mountInRoom();

    expect(await copyLink()).toBe(false);
    expect(api.linkCopied).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("admits it when there is no clipboard at all", async () => {
    // `navigator.clipboard` is absent over plain HTTP, which is how this is
    // reached on a LAN address in development.
    withoutClipboard();
    mountInRoom();

    expect(await copyLink()).toBe(false);
  });

  it("has nothing to copy on the local canvas", async () => {
    // No room, no link — and nothing put on the clipboard over the top of
    // whatever the user had there.
    mountInRoom(null);

    expect(await copyLink()).toBe(false);
    expect(copied).toEqual([]);
  });

  it("leaves no timer running once the board is closed", async () => {
    /*
     * Two timers outlive a naive unmount: this two-second confirmation and the
     * five-second cursor sweep, both of which set state on a component that is
     * gone the moment the user navigates away mid-copy.
     *
     * The zero-length advances drain jsdom's own bookkeeping — it queues a task
     * per `localStorage` write, and the identity is written during mount — so
     * that what is left to count is only what this provider scheduled.
     */
    const { unmount } = mountInRoom();
    advance(0);
    const idle = vi.getTimerCount(); // the cursor sweep, and nothing else

    await copyLink();
    advance(0);
    expect(vi.getTimerCount()).toBe(idle + 1);

    unmount();
    advance(0);

    expect(vi.getTimerCount()).toBe(0);
  });
});
