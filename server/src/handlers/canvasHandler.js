const roomStore = require('../state');
const { scheduleFlush } = require('../roomState');
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
      const capped = safeShapes.slice(0, MAX_SHAPES_PER_ROOM);
      roomStore.setCanvasState(roomId, capped);
      scheduleFlush(roomId, capped);
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
    const { roomId, shapes, deletedShapeIds, fullUpdate, isTransient } = data || {};
    if (!isValidRoomId(roomId)) return;
    if (roomStore.userRooms.get(socket.id) !== roomId) return;

    const isFullUpdate = Boolean(fullUpdate);
    const safeShapes = sanitizeShapes(shapes);
    const safeDeleted = sanitizeDeletedIds(deletedShapeIds);

    // A full update that is deliberately empty is a clear (undo-to-empty), and
    // the one payload `sanitizeShapes` maps to null that still has to act. Every
    // other empty array — a partial update, a peer's state response — stays a
    // no-op, so a peer answering before it hydrated cannot blank the room.
    const clearsScene =
      isFullUpdate && Array.isArray(shapes) && shapes.length === 0;

    if (!safeShapes && !safeDeleted && !clearsScene) return;

    roomStore.updateCanvasState(
      roomId,
      clearsScene ? [] : safeShapes,
      safeDeleted,
      isFullUpdate,
    );
    scheduleFlush(roomId, roomStore.getCanvasState(roomId) || []);

    /*
     * A mid-gesture preview is merged into the room's scene like any other
     * update — the server holds the merged authoritative scene, and a preview
     * that lived only on the wire would leave the store and the peers
     * disagreeing if the sender dropped mid-drag. What the flag changes is the
     * relay: a preview the recipient's socket could not take yet is dropped
     * rather than queued ahead of the committed update behind it, and the next
     * preview or the commit on release corrects anything lost. Anything that
     * deletes, clears or claims a full update takes the reliable path.
     */
    const transient =
      Boolean(isTransient) && !isFullUpdate && !clearsScene && !safeDeleted;

    // Forward only the sanitized fields to all other clients in the room.
    const payload = {
      roomId,
      shapes: clearsScene ? [] : safeShapes,
      deletedShapeIds: safeDeleted,
      fullUpdate: isFullUpdate,
      ...(transient ? { isTransient: true } : {}),
    };

    if (transient) {
      socket.to(roomId).volatile.emit('canvas-update', payload);
    } else {
      socket.to(roomId).emit('canvas-update', payload);
    }
  });
}

module.exports = registerCanvasHandlers;
