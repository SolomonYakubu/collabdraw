// Socket.IO server for CollabDraw
const express = require("express");
const http = require("http");
const cors = require("cors");
const config = require("./config");
const initSocket = require("./socket");
const roomStore = require("./state");
const { closeRedis } = require("./redis");
const { flushAllRooms } = require("./roomState");
const { closePool } = require("./db");
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

// Graceful shutdown handling (SIGINT for local dev, SIGTERM for cloud containers)
const shutdown = () => {
  console.log("Shutting down CollabDraw Socket.IO server...");
  io.close(async () => {
    // Persist any dirty rooms before the process exits.
    await flushAllRooms().catch(() => {});
    await closeGenerationQueue().catch(() => {});
    await closeRedis().catch(() => {});
    await closePool().catch(() => {});
    server.close(() => {
      console.log("Server has been closed");
      process.exit(0);
    });
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { app, server, io };
