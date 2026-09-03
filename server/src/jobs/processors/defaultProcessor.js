/**
 * Default AI generation job processor for BullMQ workers.
 *
 * Processes background or batched diagram generation jobs without blocking
 * the realtime WebSocket server.
 */

async function defaultProcessor(job) {
  const { prompt, mode, roomId, userId } = job.data || {};

  console.log(`[Job ${job.id}] Processing generation request: "${prompt?.slice(0, 50)}..."`);
  await job.updateProgress(10);

  if (!prompt || typeof prompt !== "string") {
    throw new Error("Job payload must contain a valid prompt string.");
  }

  // Simulate or process steps
  await job.updateProgress(40);

  // When model API keys are provided in worker environment:
  const result = {
    jobId: job.id,
    prompt: prompt.trim(),
    mode: mode || "diagram",
    roomId: roomId || null,
    userId: userId || null,
    timestamp: Date.now(),
    status: "completed",
    summary: `Processed diagram generation for: ${prompt.trim().slice(0, 60)}`,
  };

  await job.updateProgress(100);
  return result;
}

module.exports = defaultProcessor;
