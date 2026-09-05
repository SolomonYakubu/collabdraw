// Socket.IO server for CollabDraw
const express = require("express");
const http = require("http");
const cors = require("cors");
const config = require("./config");
const initSocket = require("./socket");
const roomStore = require("./state");
const { closeRedis } = require("./redis");
const { flushAllRooms, setPersistenceReporter } = require("./roomState");
const { SCENE_WRITE, closePool } = require("./db");
const { createShutdown, installShutdownHandlers } = require("./shutdown");
const {
  closeGenerationQueue,
  enqueueGenerationJob,
  getGenerationJob,
} = require("./jobs/generationQueue");

const app = express();
app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(express.json({ limit: "5mb" }));

const server = http.createServer(app);

// Initialize Socket.IO
const io = initSocket(server);

/**
 * Tell a room whether its drawing is actually being kept.
 *
 * This process is the writer while anyone is connected, and it can fail to write
 * for reasons only it can see: the board was deleted from the gallery in another
 * tab, the scene outgrew the column, Postgres is unreachable. Each of those used
 * to be a line in a log nobody reads, while the room kept drawing into a 24-hour
 * Redis cache — so the work existed until it silently did not.
 *
 * `reason` is the write outcome itself, which is the vocabulary the client
 * renders; `skipped` is not sent, because a deployment with no store of record
 * has nothing to warn about.
 */
setPersistenceReporter((roomId, outcome) => {
  if (outcome === SCENE_WRITE.SKIPPED) return;
  const durable = outcome === SCENE_WRITE.SAVED;
  io.to(roomId).emit("scene-persistence", {
    roomId,
    durable,
    reason: durable ? null : outcome,
  });
});

// Health check endpoint (for Render / Railway / uptime monitors)
app.get("/", (req, res) => {
  res.send("CollabDraw Socket.IO server is running");
});

// API route to get active rooms info and metrics
app.get("/stats", (req, res) => {
  const token = process.env.STATS_TOKEN;
  if (config.isProduction && token) {
    const authHeader = req.headers["authorization"] || req.headers["x-stats-token"];
    if (authHeader !== `Bearer ${token}` && authHeader !== token) {
      return res.status(401).json({ error: "Unauthorized access to server stats." });
    }
  }
  res.json(roomStore.getStats());
});

// Queue endpoint: Submit background diagram generation job
app.post("/jobs/generate", async (req, res) => {
  try {
    const { prompt, scene, mode, roomId, userId } = req.body || {};
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "A valid prompt string is required." });
    }

    const job = await enqueueGenerationJob({
      prompt: prompt.trim(),
      scene: scene || null,
      mode: mode || "diagram",
      roomId: roomId || null,
      userId: userId || null,
    });

    res.status(202).json({
      success: true,
      jobId: job.id,
      status: "queued",
      statusUrl: `/jobs/${job.id}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue job.";
    console.error("Queue submission error:", message);
    res.status(500).json({ error: message });
  }
});

// Queue endpoint: Query job status and result
app.get("/jobs/:jobId", async (req, res) => {
  try {
    const job = await getGenerationJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }
    res.json(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to retrieve job status.";
    res.status(500).json({ error: message });
  }
});

// Start listening
server.listen(config.port, () => {
  console.log(`CollabDraw Socket.IO server running on port ${config.port}`);
});

// Graceful shutdown handling (SIGINT for local dev, SIGTERM for cloud
// containers, and a crash, which is the one that used to exit with the rooms
// unwritten). The ordering and the reasoning live in ./shutdown.
const shutdown = createShutdown({
  io,
  server,
  flushRooms: flushAllRooms,
  closers: [
    { name: "the generation queue", close: closeGenerationQueue },
    { name: "Redis", close: closeRedis },
    { name: "the Postgres pool", close: closePool },
  ],
  timeoutMs: config.shutdownTimeoutMs,
});

installShutdownHandlers(shutdown);

module.exports = { app, server, io, shutdown };
