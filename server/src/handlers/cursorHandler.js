const roomStore = require("../state");
const {
  clampCoordinate,
  clampTag,
  isValidRoomId,
  sanitizeShapes,
} = require("../validation");

/**
 * Handlers for high-frequency transient collaboration events (cursors, live preview strokes).
 * Payloads are validated and clamped before relay.
 */
function registerCursorHandlers(io, socket) {
  // Handle cursor position updates (~20-60Hz per active user)
  socket.on("cursor-position", (data) => {
    const { roomId, userId, x, y, tag } = data || {};

    if (!isValidRoomId(roomId)) return;
    if (roomStore.userRooms.get(socket.id) !== roomId) return;

    const safeX = clampCoordinate(x);
    const safeY = clampCoordinate(y);
    if (userId === undefined || safeX === undefined || safeY === undefined) {
      return;
    }

    socket.to(roomId).emit("cursor-position", {
      userId,
      x: safeX,
      y: safeY,
      tag: clampTag(tag),
    });
  });

  // Handle in-progress shape updates (live drag preview)
  socket.on("shape-in-progress", (data) => {
    const { roomId, userId, shape } = data || {};
    if (!isValidRoomId(roomId)) return;
    if (roomStore.userRooms.get(socket.id) !== roomId) return;

    const [safeShape] = sanitizeShapes([shape]) ?? [];
    if (userId === undefined || !safeShape) return;

    socket.to(roomId).emit("shape-in-progress", {
      userId,
      shape: safeShape,
    });
  });

  // Handle drawing state updates (isDrawing flag for status indicators)
  socket.on("drawing-state", (data) => {
    const { roomId, userId } = data || {};
    if (!isValidRoomId(roomId)) return;
    if (roomStore.userRooms.get(socket.id) !== roomId) return;

    // `userId` is what makes this actionable: the receiver's job is to drop *that*
    // peer's in-progress preview, and without a name to hang it on the event is
    // unattributable and does nothing. Same reason the two handlers above bail.
    if (userId === undefined) return;

    socket.to(roomId).emit("drawing-state", {
      roomId,
      userId,
      isDrawing: Boolean(data && data.isDrawing),
    });
  });
}

module.exports = registerCursorHandlers;
