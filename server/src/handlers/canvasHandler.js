const roomStore = require('../state');

/**
 * Handlers for canvas state persistence and shape update broadcasting.
 */
function registerCanvasHandlers(io, socket) {
  // Handle canvas state sync responses from peers
  socket.on('canvas-state-response', (data) => {
    const { roomId, targetUserId, shapes, userId } = data || {};
    if (!roomId) return;

    if (shapes && shapes.length > 0) {
      roomStore.setCanvasState(roomId, shapes);
    }

    const targetUser = roomStore.getUserInRoom(roomId, targetUserId);
    if (targetUser && targetUser.socketId) {
      io.to(targetUser.socketId).emit('canvas-state-sync', {
        roomId,
        userId,
        shapes,
      });
      console.log(`Sent canvas state from ${userId} to ${targetUserId}`);
    }
  });

  // Handle canvas drawing updates
  socket.on('canvas-update', (data) => {
    const { roomId, shapes, deletedShapeIds, fullUpdate } = data || {};
    if (typeof roomId !== 'string' || !roomId) {
      return;
    }

    roomStore.updateCanvasState(roomId, shapes, deletedShapeIds, Boolean(fullUpdate));

    // Forward the update to all other clients in the room
    socket.to(roomId).emit('canvas-update', data);
  });
}

module.exports = registerCanvasHandlers;
