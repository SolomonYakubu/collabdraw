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
  /*
   * Identity comes from `socket.data`, never from the payload: taking `userId`
   * off the wire would let any member attribute their cursor or preview to
   * somebody else — moving the victim's cursor, or clearing their in-progress
   * shape. `join-room` stamps it, so an unidentified socket has no name and the
   * event is dropped (there is nothing to attribute it to).
   */
  const senderId = () => socket.data && socket.data.userId;

  // Handle cursor position updates (~20-60Hz per active user)
  socket.on("cursor-position", (data) => {
    const { roomId, x, y, tag } = data || {};

    if (!isValidRoomId(roomId)) return;
    if (roomStore.userRooms.get(socket.id) !== roomId) return;

    const userId = senderId();
    const safeX = clampCoordinate(x);
    const safeY = clampCoordinate(y);
    if (!userId || safeX === undefined || safeY === undefined) {
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
    const { roomId, shape } = data || {};
    if (!isValidRoomId(roomId)) return;
    if (roomStore.userRooms.get(socket.id) !== roomId) return;

    const userId = senderId();
    const [safeShape] = sanitizeShapes([shape]) ?? [];
    if (!userId || !safeShape) return;

    socket.to(roomId).emit("shape-in-progress", {
      userId,
      shape: safeShape,
    });
  });

  // Handle drawing state updates (isDrawing flag for status indicators)
  socket.on("drawing-state", (data) => {
    const { roomId } = data || {};
    if (!isValidRoomId(roomId)) return;
    if (roomStore.userRooms.get(socket.id) !== roomId) return;

    // The name is what makes this actionable: the receiver's job is to drop
    // *that* peer's in-progress preview. Same reason the two handlers above bail.
    const userId = senderId();
    if (!userId) return;

    socket.to(roomId).emit("drawing-state", {
      roomId,
      userId,
      isDrawing: Boolean(data && data.isDrawing),
    });
  });
}

module.exports = registerCursorHandlers;
