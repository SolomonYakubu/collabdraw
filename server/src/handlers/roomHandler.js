const roomStore = require('../state');
const { loadCanvasState, loadBoardScene } = require('../roomState');
const { clampTag, isValidRoomId } = require('../validation');

/**
 * How long a cluster-wide roster lookup may take before the local store answers
 * instead.
 *
 * The Redis adapter's own request timeout defaults to 5000ms, and one
 * unresponsive peer — a sleeping instance, a redeploy that left a stale entry —
 * was enough to stall every join, and the scene sync behind it, for the whole
 * five seconds. A roster is worth a moment, not five of them: the local store
 * already knows everyone on this instance, and the next roster broadcast picks
 * up whoever it missed.
 */
const CLUSTER_ROSTER_TIMEOUT_MS = 1200;

/**
 * Fetch all users across a cluster using the Redis-backed adapter if available,
 * falling back to the local instance memory store.
 *
 * Ordered by when each user joined, because the client reads the first entry as
 * the room's host — the person a newcomer's view is centred on. A cluster
 * `fetchSockets()` returns sockets in no particular order, so the join time is
 * what makes "first in the room" mean the same thing on every instance. A user
 * with several tabs is folded to their earliest socket.
 */
async function getClusterRoomUsers(io, roomId) {
  let timer;
  try {
    const sockets = await Promise.race([
      io.in(roomId).fetchSockets(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("cluster roster timed out")),
          CLUSTER_ROSTER_TIMEOUT_MS,
        );
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    const byUser = new Map();
    for (const s of sockets) {
      if (!s.data || !s.data.userId) continue;
      const joinedAt = Number(s.data.joinedAt) || 0;
      const existing = byUser.get(s.data.userId);
      if (!existing || joinedAt < existing.joinedAt) {
        byUser.set(s.data.userId, {
          id: s.data.userId,
          tag: s.data.userTag || "Anonymous",
          joinedAt,
        });
      }
    }
    if (byUser.size > 0) {
      return Array.from(byUser.values())
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map(({ id, tag }) => ({ id, tag }));
    }
  } catch {
    // Adapter fallback
  } finally {
    clearTimeout(timer);
  }
  return roomStore.getRoomUsers(roomId);
}

/**
 * Handlers for room membership and user lifecycle events.
 */
function registerRoomHandlers(io, socket) {
  // Handle join room event
  socket.on('join-room', async (data) => {
    const { roomId, userId, userTag } = data || {};
    if (!isValidRoomId(roomId)) return;
    if (typeof userId !== 'string' || !userId || userId.length > 128) return;

    const safeTag = clampTag(userTag) || "Anonymous";

    // Attach data for cluster-wide fetchSockets()
    socket.data.userId = userId;
    socket.data.userTag = safeTag;
    socket.data.roomId = roomId;
    // The cluster-wide ordering behind "who is the host" — see
    // `getClusterRoomUsers`. Date.now is enough; a same-millisecond tie is
    // broken by the stable sort, and nothing depends on which of two
    // simultaneous joins is the host for more than one frame.
    socket.data.joinedAt = Date.now();

    // Leave any previously joined room so a socket belongs to exactly one.
    const previousRoom = roomStore.userRooms.get(socket.id);
    if (previousRoom && previousRoom !== roomId) {
      socket.leave(previousRoom);
      const { isEmpty } = roomStore.removeUserBySocketId(socket.id);
      if (!isEmpty) {
        // Nothing below depends on the old room's roster, and nothing on this
        // join should wait for it: cluster lookups can stall on a slow peer.
        void getClusterRoomUsers(io, previousRoom).then((remaining) => {
          io.to(previousRoom).emit('active-users', { users: remaining });
        });
      }
    }

    socket.join(roomId);
    roomStore.addUserToRoom(roomId, userId, safeTag, socket.id);

    /*
     * The roster is broadcast when its lookup answers, not awaited here: the
     * lookup is bounded (a slow peer cannot hold a join for five seconds), and
     * the scene sync below no longer waits behind it. The joiner's own hand
     * gets its scene from the same round trip regardless of who else the
     * roster eventually includes.
     */
    const rosterChain = getClusterRoomUsers(io, roomId)
      .then((users) => {
        io.to(roomId).emit('active-users', { users });
        console.log(`User ${safeTag} joined room ${roomId}`);
      });

    /*
     * Hydration fallback chain: local memory -> Redis hot cache -> Postgres
     * store of record. The first source that *has* an answer wins — including an
     * empty one. Treating an empty scene as "no answer" and falling through to
     * the durable store resurrected shapes a user had just deleted but whose
     * debounced flush had not landed yet.
     */
    let persistedState = roomStore.hasCanvasState(roomId)
      ? roomStore.getCanvasState(roomId)
      : undefined;
    if (persistedState === undefined) {
      const cached = await loadCanvasState(roomId);
      if (cached !== null) {
        persistedState = cached;
      }
    }
    if (persistedState === undefined) {
      const durable = await loadBoardScene(roomId);
      if (durable && durable.length > 0) {
        persistedState = durable;
      }
    }
    if (Array.isArray(persistedState)) {
      // Seed the local cache so later joiners are served without another round
      // trip, and so an authoritative empty scene is not re-investigated.
      roomStore.setCanvasState(roomId, persistedState);
    }
    if (persistedState && persistedState.length > 0) {
      socket.emit('canvas-state-sync', {
        roomId,
        userId: 'server',
        shapes: persistedState,
      });
      console.log(`Sent stored canvas state to new user ${safeTag} in room ${roomId}`);
    } else if (roomStore.getRoomUsers(roomId).length > 1) {
      // Otherwise request state from an existing peer in the room. The check
      // and the socket list are both local on purpose — `fetchSockets` across
      // the adapter is the lookup this join was made to outlive.
      const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      const otherSocketIds = roomSockets.filter((id) => id !== socket.id);

      if (otherSocketIds.length > 0) {
        io.to(otherSocketIds[0]).emit('request-canvas-state', {
          roomId,
          targetUserId: userId,
        });
        console.log(`Requested canvas state for new user ${safeTag} in room ${roomId}`);
      }
    }

    await rosterChain;
  });

  // Handle get active users query
  socket.on('get-active-users', async (data, callback) => {
    const { roomId } = data || {};
    if (typeof callback === 'function') {
      const isMember = roomStore.userRooms.get(socket.id) === roomId;
      const users = isMember ? await getClusterRoomUsers(io, roomId) : [];
      callback({ users });
    }
  });

  /**
   * Change your own display name mid-session.
   *
   * The identity comes from `socket.data`, never from the payload: taking the
   * userId off the wire would let any client rename anybody else in the room.
   * Only the tag is read from the message, and `clampTag` bounds it.
   */
  socket.on('update-user-name', async (data) => {
    const roomId = socket.data && socket.data.roomId;
    const userId = socket.data && socket.data.userId;
    if (!roomId || !userId || roomStore.userRooms.get(socket.id) !== roomId) {
      return;
    }

    const safeTag = clampTag(data && data.userTag);
    if (!safeTag || safeTag === socket.data.userTag) {
      return;
    }

    // Both stores: `socket.data` is what the cluster-wide roster reads,
    // `roomStore` what the single-instance fallback reads.
    socket.data.userTag = safeTag;
    roomStore.setUserTag(roomId, userId, safeTag);

    const users = await getClusterRoomUsers(io, roomId);
    io.to(roomId).emit('active-users', { users });
  });

  // Handle user disconnect
  socket.on('disconnect', async () => {
    const { roomId, user, isEmpty } = roomStore.removeUserBySocketId(socket.id);

    if (roomId) {
      if (user) {
        console.log(`User ${user.tag} left room ${roomId}`);
      }

      if (isEmpty) {
        console.log(`Room ${roomId} is now empty and removed`);
      } else {
        const users = await getClusterRoomUsers(io, roomId);
        io.to(roomId).emit('active-users', { users });
      }
    }
  });
}

module.exports = registerRoomHandlers;
