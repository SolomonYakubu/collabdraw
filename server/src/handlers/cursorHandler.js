/**
 * Handlers for high-frequency transient collaboration events (cursors, live preview strokes).
 */
function registerCursorHandlers(io, socket) {
  // Handle cursor position updates (~20-60Hz per active user)
  socket.on('cursor-position', (data) => {
    const { roomId, userId, x, y, tag } = data || {};

    if (roomId && userId !== undefined && x !== undefined && y !== undefined) {
      socket.to(roomId).emit('cursor-position', {
        userId,
        x,
        y,
        tag,
      });
    }
  });

  // Handle in-progress shape updates (live drag preview)
  socket.on('shape-in-progress', (data) => {
    const { roomId, userId, shape } = data || {};
    if (roomId && shape) {
      socket.to(roomId).emit('shape-in-progress', {
        userId,
        shape,
      });
    }
  });

  // Handle drawing state updates (isDrawing flag for status indicators)
  socket.on('drawing-state', (data) => {
    const { roomId } = data || {};
    if (typeof roomId === 'string' && roomId) {
      socket.to(roomId).emit('drawing-state', data);
    }
  });
}

module.exports = registerCursorHandlers;
