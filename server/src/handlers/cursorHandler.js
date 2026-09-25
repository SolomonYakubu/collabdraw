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

    socket.to(roomId).volatile.emit("cursor-position", {
      userId,
      x: safeX,
      y: safeY,
      tag: clampTag(tag),
    });
  });

  /*
   * The same cursor, relayed reliably because it is sent once, on purpose: a
   * peer who has just joined needs the host's position to centre their view,
   * and a dropped seed leaves them staring at empty space with nothing to tell
   * them the host exists. Ordinary cursor traffic stays volatile above; this is
   * the one cursor message whose loss costs more than a frame of polish.
   */
  socket.on("announce-cursor", (data) => {
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
    const { roomId, shape, pointsOffset } = data || {};
    if (!isValidRoomId(roomId)) return;
    if (roomStore.userRooms.get(socket.id) !== roomId) return;

    const userId = senderId();
    const [safeShape] = sanitizeShapes([shape]) ?? [];
    if (!userId || !safeShape) return;

    const payload = { userId, shape: safeShape };

    // A freehand stroke travels as increments against the copy the receiver
    // already holds; the offset is how many flat point values it should have.
    // Only forward it when it is a real offset — absent means a full snapshot.
    if (
      typeof pointsOffset === "number" &&
      Number.isFinite(pointsOffset) &&
      pointsOffset > 0
    ) {
      payload.pointsOffset = pointsOffset;
    }

    // Volatile for the same reason the client sends it volatile: a preview the
    // recipient could not take yet is worth less than the shape update behind it,
    // and queuing it on their socket delays that.
    socket.to(roomId).volatile.emit("shape-in-progress", payload);
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
