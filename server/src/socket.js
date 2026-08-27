const { Server } = require("socket.io");
const config = require("./config");
const registerRoomHandlers = require("./handlers/roomHandler");
const registerCanvasHandlers = require("./handlers/canvasHandler");
const registerCursorHandlers = require("./handlers/cursorHandler");
const { configureSocketAdapter, initRedis } = require("./redis");

/**
 * Initialize Socket.IO with CORS and event dispatchers.
 */
function initSocket(httpServer) {
  const redisClients = initRedis();
  const io = new Server(httpServer, {
    cors: {
      origin: config.clientOrigin,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });
  configureSocketAdapter(io, redisClients);

  io.on("connection", (socket) => {
    const { userId, userTag, roomId } = socket.handshake.query;
    console.log(`User connected: ${userTag} (${userId}) in room ${roomId}`);

    // Register modular event listeners
    registerRoomHandlers(io, socket);
    registerCanvasHandlers(io, socket);
    registerCursorHandlers(io, socket);
  });

  return io;
}

module.exports = initSocket;
