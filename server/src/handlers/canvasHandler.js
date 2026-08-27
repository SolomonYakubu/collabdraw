const roomStore = require('../state');
const { saveCanvasState } = require('../roomState');
const {
  MAX_SHAPES_PER_ROOM,
  isValidRoomId,
  sanitizeDeletedIds,
  sanitizeShapes,
} = require('../validation');

/**
 * Handlers for canvas state persistence and shape update broadcasting.
 * All client payloads are validated and capped before storage or relay.
 */
function registerCanvasHandlers(io, socket) {
  // Handle canvas state sync responses from peers
  socket.on('canvas-state-response', (data) => {
    const { roomId, targetUserId, shapes, userId } = data || {};
    if (!isValidRoomId(roomId)) return;

    // Only trust state claims from sockets actually in that room; otherwise a
    // peer could overwrite the cached canvas for everyone joining later.
    if (roomStore.userRooms.get(socket.id) !== roomId) return;

    const safeShapes = sanitizeShapes(shapes);
    if (safeShapes) {
      roomStore.setCanvasState(roomId, safeShapes.slice(0, MAX_SHAPES_PER_ROOM));
      void saveCanvasState(roomId, safeShapes.slice(0, MAX_SHAPES_PER_ROOM));
    }

    const targetUser = roomStore.getUserInRoom(roomId, targetUserId);
    if (targetUser && targetUser.socketId) {
      io.to(targetUser.socketId).emit('canvas-state-sync', {
        roomId,
        userId,
        shapes: safeShapes,
      });
      console.log(`Sent canvas state from ${userId} to ${targetUserId}`);
    }
  });

  // Handle canvas drawing updates
  socket.on('canvas-update', (data) => {
    const { roomId, shapes, deletedShapeIds, fullUpdate } = data || {};
    if (!isValidRoomId(roomId)) return;
    if (roomStore.userRooms.get(socket.id) !== roomId) return;

    const safeShapes = sanitizeShapes(shapes);
    const safeDeleted = sanitizeDeletedIds(deletedShapeIds);

    if (!safeShapes && !safeDeleted) return;

    roomStore.updateCanvasState(roomId, safeShapes, safeDeleted, Boolean(fullUpdate));
    void saveCanvasState(roomId, roomStore.getCanvasState(roomId) || []);

    // Forward only the sanitized fields to all other clients in the room.
    socket.to(roomId).emit('canvas-update', {
      roomId,
      shapes: safeShapes,
      deletedShapeIds: safeDeleted,
      fullUpdate: Boolean(fullUpdate),
    });
  });
}

module.exports = registerCanvasHandlers;
