const roomStore = require('../state');
const { loadCanvasState, loadBoardScene } = require('../roomState');
const { clampTag, isValidRoomId } = require('../validation');

/**
 * Fetch all users across a cluster using the Redis-backed adapter if available,
 * falling back to the local instance memory store.
 */
async function getClusterRoomUsers(io, roomId) {
  try {
    const sockets = await io.in(roomId).fetchSockets();
    const userMap = new Map();
    for (const s of sockets) {
      if (s.data && s.data.userId) {
        userMap.set(s.data.userId, {
          id: s.data.userId,
          tag: s.data.userTag || "Anonymous",
        });
      }
    }
    if (userMap.size > 0) {
      return Array.from(userMap.values());
    }
  } catch {
    // Adapter fallback
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

    // Leave any previously joined room so a socket belongs to exactly one.
    const previousRoom = roomStore.userRooms.get(socket.id);
    if (previousRoom && previousRoom !== roomId) {
      socket.leave(previousRoom);
      const { isEmpty } = roomStore.removeUserBySocketId(socket.id);
      if (!isEmpty) {
        const remaining = await getClusterRoomUsers(io, previousRoom);
        io.to(previousRoom).emit('active-users', { users: remaining });
      }
    }

    socket.join(roomId);
    roomStore.addUserToRoom(roomId, userId, safeTag, socket.id);

    const users = await getClusterRoomUsers(io, roomId);
    io.to(roomId).emit('active-users', { users });
    console.log(`User ${safeTag} joined room ${roomId}`);

    // Hydration fallback chain: local memory -> Redis hot cache -> Postgres
    // store of record. First non-empty wins; seed the local cache so later
    // joiners are served without another round-trip.
    let persistedState = roomStore.hasCanvasState(roomId)
      ? roomStore.getCanvasState(roomId)
      : await loadCanvasState(roomId);
    if (!persistedState || persistedState.length === 0) {
      const durable = await loadBoardScene(roomId);
      if (durable && durable.length > 0) {
        persistedState = durable;
      }
    }
    if (persistedState && persistedState.length > 0) {
      roomStore.setCanvasState(roomId, persistedState);
      socket.emit('canvas-state-sync', {
        roomId,
        userId: 'server',
        shapes: persistedState,
      });
      console.log(`Sent stored canvas state to new user ${safeTag} in room ${roomId}`);
    } else if (users.length > 1) {
      // Otherwise request state from an existing peer in the room
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
