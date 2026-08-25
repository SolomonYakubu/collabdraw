// Socket.IO server for CollabDraw
const express = require('express');
const http = require('http');
const cors = require('cors');
const config = require('./config');
const initSocket = require('./socket');
const roomStore = require('./state');

const app = express();
app.use(cors({ origin: config.clientOrigin, credentials: true }));

const server = http.createServer(app);

// Initialize Socket.IO
const io = initSocket(server);

// Health check endpoint (for Render / Railway / uptime monitors)
app.get('/', (req, res) => {
  res.send('CollabDraw Socket.IO server is running');
});

// API route to get active rooms info and metrics
app.get('/stats', (req, res) => {
  res.json(roomStore.getStats());
});

// Start listening
server.listen(config.port, () => {
  console.log(`CollabDraw Socket.IO server running on port ${config.port}`);
});

// Graceful shutdown handling (SIGINT for local dev, SIGTERM for cloud containers)
const shutdown = () => {
  console.log('Shutting down CollabDraw Socket.IO server...');
  server.close(() => {
    console.log('Server has been closed');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, io };
