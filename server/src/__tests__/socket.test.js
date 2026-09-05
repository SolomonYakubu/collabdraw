/**
 * Socket.IO's construction: CORS, the shared adapter, and what a new connection
 * gets wired to.
 *
 * Small, but it is the only place the three handler modules are attached, and the
 * only place the origin allowed to open a socket is decided. A connection that
 * reaches the wrong number of `register` calls is a client whose events land
 * nowhere, and an origin of `*` is any page on the internet joining your rooms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModuleCache } from "./helpers/moduleCache.js";

const cache = createModuleCache();

const REDIS_CLIENTS = Symbol("redis clients");

let servers;
let registered;
let configureSocketAdapter;
let initRedis;

const load = ({ clientOrigin = "http://localhost:3000", redisClients = null } = {}) => {
  servers = [];
  registered = [];

  cache.plant("./config.js", { clientOrigin });

  cache.plant("socket.io", {
    Server: class FakeServer {
      constructor(httpServer, options) {
        this.httpServer = httpServer;
        this.options = options;
        this.listeners = new Map();
        this.on = vi.fn((event, listener) => this.listeners.set(event, listener));
        this.adapter = vi.fn();
        servers.push(this);
      }
    },
  });

  initRedis = vi.fn(() => redisClients);
  configureSocketAdapter = vi.fn();
  cache.plant("./redis.js", { initRedis, configureSocketAdapter });

  for (const name of ["roomHandler", "canvasHandler", "cursorHandler"]) {
    cache.plant(`./handlers/${name}.js`, (io, socket) => {
      registered.push({ name, io, socket });
    });
  }

  return cache.load("./socket.js");
};

/** A connecting client, as far as this module reads one. */
const client = (query = {}) => ({ id: "socket-1", data: {}, handshake: { query } });

let initSocket;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initSocket = load();
});

afterEach(() => {
  cache.reset();
  vi.restoreAllMocks();
});
const HTTP_SERVER = Symbol("http server");

/** Hand a connecting client to the `connection` listener the module registered. */
const connect = (io, socket = client()) => {
  io.listeners.get("connection")(socket);
  return socket;
};

describe("building the server", () => {
  it("wraps the http server it was handed, and answers with the io", () => {
    const io = initSocket(HTTP_SERVER);

    expect(servers).toHaveLength(1);
    expect(io).toBe(servers[0]);
    expect(io.httpServer).toBe(HTTP_SERVER);
  });

  it("lets in the configured client origin, and only that one", () => {
    // `origin: "*"` here would let any page on the internet open a socket and join
    // a room by id, which is most of the access control this server has.
    initSocket(HTTP_SERVER);

    expect(servers[0].options.cors.origin).toBe("http://localhost:3000");
  });

  it("follows the deployment's origin rather than a baked-in one", () => {
    initSocket = load({ clientOrigin: "https://collabdraw.example" });

    initSocket(HTTP_SERVER);

    expect(servers[0].options.cors.origin).toBe("https://collabdraw.example");
  });

  it("allows the two methods the transport needs, with credentials", () => {
    initSocket(HTTP_SERVER);

    expect(servers[0].options.cors).toEqual({
      origin: "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true,
    });
  });
});
describe("the adapter", () => {
  it("opens the Redis clients once for the server, not once per client", () => {
    const io = initSocket(HTTP_SERVER);
    connect(io);
    connect(io);

    expect(initRedis).toHaveBeenCalledTimes(1);
  });

  it("hands Socket.IO whatever Redis it got", () => {
    initSocket = load({ redisClients: REDIS_CLIENTS });

    const io = initSocket(HTTP_SERVER);

    expect(configureSocketAdapter).toHaveBeenCalledWith(io, REDIS_CLIENTS);
  });

  it("still asks when there is no Redis, rather than skipping the call", () => {
    // `configureSocketAdapter` is the one place that chooses between the shared
    // adapter and the in-memory one, so it has to be reached either way.
    const io = initSocket(HTTP_SERVER);

    expect(configureSocketAdapter).toHaveBeenCalledWith(io, null);
  });

  it("is in place before the server starts accepting connections", () => {
    // On a cluster, a socket that connects before `io.adapter(...)` is set joins a
    // room whose broadcasts never leave this instance.
    const listenersWhenConfigured = [];
    configureSocketAdapter.mockImplementation((io) =>
      listenersWhenConfigured.push(...io.on.mock.calls.map(([event]) => event)),
    );

    initSocket(HTTP_SERVER);

    expect(listenersWhenConfigured).toEqual([]);
    expect(servers[0].on).toHaveBeenCalledWith("connection", expect.any(Function));
  });
});
describe("a client that connects", () => {
  it("is the only thing the server listens for", () => {
    const io = initSocket(HTTP_SERVER);

    expect(io.on.mock.calls.map(([event]) => event)).toEqual(["connection"]);
  });

  it("gets all three handler modules, each once, with the io and itself", () => {
    // Registered twice and every event this client sends is handled twice: two
    // strokes stored, two relays, two roster broadcasts.
    const io = initSocket(HTTP_SERVER);
    const socket = connect(io);

    expect(registered).toEqual([
      { name: "roomHandler", io, socket },
      { name: "canvasHandler", io, socket },
      { name: "cursorHandler", io, socket },
    ]);
  });

  it("is wired independently of the client before it", () => {
    const io = initSocket(HTTP_SERVER);
    const first = connect(io);
    const second = connect(io, { ...client(), id: "socket-2" });

    expect(registered.filter((entry) => entry.socket === first)).toHaveLength(3);
    expect(registered.filter((entry) => entry.socket === second)).toHaveLength(3);
  });

  it("does not have to say who it is to be wired up", () => {
    // The client connects first and joins a room afterwards, so a socket with an
    // empty handshake still needs its listeners or `join-room` is never heard.
    const io = initSocket(HTTP_SERVER);

    expect(() => connect(io, client())).not.toThrow();
    expect(registered).toHaveLength(3);
  });

  it("does not become whoever the handshake claims to be", () => {
    // The query is client-supplied and only logged. Identity is established by
    // `join-room`, which validates the ids and is the only writer of `socket.data`.
    const io = initSocket(HTTP_SERVER);

    const socket = connect(io, client({ userId: "admin", userTag: "Ada", roomId: "r1" }));

    expect(socket.data).toEqual({});
  });
});
