/**
 * In-memory state store for active collaboration rooms, connected users,
 * and current canvas shape states.
 */
const { MAX_SHAPES_PER_ROOM } = require("./validation");

class RoomStore {
  constructor() {
    /** @type {Map<string, Map<string, { id: string, tag: string, socketId: string }>>} */
    this.activeRooms = new Map();
    /** @type {Map<string, string>} socket.id -> roomId */
    this.userRooms = new Map();
    /** @type {Map<string, Array<any>>} roomId -> shapes array */
    this.roomCanvasStates = new Map();
  }

  /**
   * Return a list of users currently in a room.
   */
  getRoomUsers(roomId) {
    if (!this.activeRooms.has(roomId)) return [];
    return Array.from(this.activeRooms.get(roomId).values()).map((u) => ({
      id: u.id,
      tag: u.tag,
    }));
  }

  /**
   * Find a specific user in a room.
   */
  getUserInRoom(roomId, userId) {
    return this.activeRooms.get(roomId)?.get(userId) || null;
  }

  /**
   * Add a user to a room.
   */
  addUserToRoom(roomId, userId, userTag, socketId) {
    if (!this.activeRooms.has(roomId)) {
      this.activeRooms.set(roomId, new Map());
    }
    this.activeRooms.get(roomId).set(userId, {
      id: userId,
      tag: userTag,
      socketId,
    });
    this.userRooms.set(socketId, roomId);
  }

  /**
   * Rename a user already in a room. Returns whether anything changed, so the
   * caller can skip a pointless `active-users` broadcast.
   */
  setUserTag(roomId, userId, userTag) {
    const user = this.activeRooms.get(roomId)?.get(userId);
    if (!user || user.tag === userTag) {
      return false;
    }
    user.tag = userTag;
    return true;
  }

  /**
   * Remove a user from their active room on disconnect.
   */
  removeUserBySocketId(socketId) {
    const roomId = this.userRooms.get(socketId);
    this.userRooms.delete(socketId);

    if (!roomId || !this.activeRooms.has(roomId)) {
      return { roomId: null, user: null, isEmpty: false };
    }

    const room = this.activeRooms.get(roomId);
    let removedUser = null;

    for (const [userId, userData] of room.entries()) {
      if (userData.socketId === socketId) {
        removedUser = userData;
        room.delete(userId);
        break;
      }
    }

    const isEmpty = room.size === 0;
    if (isEmpty) {
      // Forced durable flush before the in-memory scene is dropped, so the last
      // edits survive the room going empty. Lazy require avoids a load-time
      // cycle (roomState -> db -> ... does not import state).
      //
      // Nothing holds the returned promise — this method is synchronous, and the
      // disconnect it serves has a roster to broadcast. `roomState` keeps track
      // of the write instead, which is how shutdown can wait for it: `io.close()`
      // disconnects everyone at once, so these are the flushes that decide
      // whether the last minute of a session survives.
      const finalScene = this.roomCanvasStates.get(roomId);
      if (Array.isArray(finalScene) && finalScene.length > 0) {
        const { flushRoomNow } = require("./roomState");
        void flushRoomNow(roomId, finalScene);
      }
      this.activeRooms.delete(roomId);
      this.roomCanvasStates.delete(roomId);
    }

    return { roomId, user: removedUser, isEmpty };
  }

  /**
   * Retrieve cached canvas shapes for a room.
   */
  getCanvasState(roomId) {
    return this.roomCanvasStates.get(roomId);
  }

  /**
   * Check if canvas state exists for a room.
   */
  hasCanvasState(roomId) {
    return this.roomCanvasStates.has(roomId);
  }

  /**
   * Overwrite canvas state for a room.
   */
  setCanvasState(roomId, shapes) {
    this.roomCanvasStates.set(roomId, shapes.slice(0, MAX_SHAPES_PER_ROOM));
  }

  /**
   * Merge updates (incremental or full) and deletions into the room state.
   */
  updateCanvasState(roomId, shapes, deletedShapeIds, isFullUpdate = false) {
    if (shapes && shapes.length > 0) {
      if (isFullUpdate || !this.roomCanvasStates.has(roomId)) {
        this.roomCanvasStates.set(roomId, shapes);
      } else {
        const merged = [...this.roomCanvasStates.get(roomId)];
        shapes.forEach((incomingShape) => {
          const index = merged.findIndex(
            (shape) => String(shape.id) === String(incomingShape.id),
          );
          if (index >= 0) {
            merged[index] = incomingShape;
          } else {
            merged.push(incomingShape);
          }
        });
        this.roomCanvasStates.set(
          roomId,
          merged.slice(0, MAX_SHAPES_PER_ROOM),
        );
      }
    }

    if (
      deletedShapeIds &&
      deletedShapeIds.length > 0 &&
      this.roomCanvasStates.has(roomId)
    ) {
      const currentShapes = this.roomCanvasStates.get(roomId);
      const deleted = new Set(deletedShapeIds.map(String));
      const updatedShapes = currentShapes.filter(
        (shape) => !deleted.has(String(shape.id)),
      );
      this.roomCanvasStates.set(roomId, updatedShapes);
    }
  }

  /**
   * Return telemetry stats for monitoring.
   */
  getStats() {
    return {
      activeRooms: this.activeRooms.size,
      rooms: Array.from(this.activeRooms.entries()).map(([roomId, users]) => ({
        roomId,
        userCount: users.size,
        hasCanvasState: this.roomCanvasStates.has(roomId),
      })),
    };
  }
}

module.exports = new RoomStore();
