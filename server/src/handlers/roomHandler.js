const roomStore = require('../state');
const { loadCanvasState } = require('../roomState');
const { clampTag, isValidRoomId } = require('../validation');

/**
 * Handlers for room membership and user lifecycle events.
 */
function registerRoomHandlers(io, socket) {
  // Handle join room event
  socket.on('join-room', async (data) => {
    const { roomId, userId, userTag } = data || {};
    if (!isValidRoomId(roomId)) return;
    if (typeof userId !== 'string' || !userId || userId.length > 128) return;

    // Leave any previously joined room so a socket belongs to exactly one.
    const previousRoom = roomStore.userRooms.get(socket.id);
    if (previousRoom && previousRoom !== roomId) {
      socket.leave(previousRoom);
      const { isEmpty } = roomStore.removeUserBySocketId(socket.id);
      if (!isEmpty) {
        io.to(previousRoom).emit('active-users', {
          users: roomStore.getRoomUsers(previousRoom),
        });
      }
    }

    socket.join(roomId);
    roomStore.addUserToRoom(roomId, userId, clampTag(userTag), socket.id);

    const users = roomStore.getRoomUsers(roomId);
    io.to(roomId).emit('active-users', { users });
    console.log(`User ${userTag} joined room ${roomId}`);

    // If canvas state is already cached on the server, sync directly. Redis is
    // the restart-safe fallback when this process has no local snapshot yet.
    const persistedState = roomStore.hasCanvasState(roomId)
      ? roomStore.getCanvasState(roomId)
      : await loadCanvasState(roomId);
    if (persistedState) {
      roomStore.setCanvasState(roomId, persistedState);
      socket.emit('canvas-state-sync', {
        roomId,
        userId: 'server',
        shapes: persistedState,
      });
      console.log(`Sent stored canvas state to new user ${userTag} in room ${roomId}`);
    } else if (users.length > 1) {
      // Otherwise request state from an existing peer in the room
      const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      const otherSocketIds = roomSockets.filter((id) => id !== socket.id);

      if (otherSocketIds.length > 0) {
        io.to(otherSocketIds[0]).emit('request-canvas-state', {
          roomId,
          targetUserId: userId,
        });
        console.log(`Requested canvas state for new user ${userTag} in room ${roomId}`);
      }
    }
  });

  // Handle get active users query
  socket.on('get-active-users', (data, callback) => {
    const { roomId } = data || {};
    if (typeof callback === 'function') {
      callback({
        users:
          roomStore.userRooms.get(socket.id) === roomId
            ? roomStore.getRoomUsers(roomId)
            : [],
      });
    }
  });

  // Handle user disconnect
  socket.on('disconnect', () => {
    const { roomId, user, isEmpty } = roomStore.removeUserBySocketId(socket.id);

    if (roomId) {
      if (user) {
        console.log(`User ${user.tag} left room ${roomId}`);
      }

      if (isEmpty) {
        console.log(`Room ${roomId} is now empty and removed`);
      } else {
        io.to(roomId).emit('active-users', {
          users: roomStore.getRoomUsers(roomId),
        });
      }
    }
  });
}

module.exports = registerRoomHandlers;
