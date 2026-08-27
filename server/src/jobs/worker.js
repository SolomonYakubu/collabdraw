const { createGenerationWorker } = require("./generationQueue");
const defaultProcessor = require("./processors/defaultProcessor");

const processorModule = process.env.GENERATION_PROCESSOR_MODULE;

let processor = defaultProcessor;

if (processorModule) {
  try {
    processor = require(processorModule);
    console.log(`Using custom generation processor: ${processorModule}`);
  } catch (err) {
    console.error(`Failed to load custom processor from ${processorModule}, falling back to default:`, err.message);
  }
} else {
  console.log("Using default AI generation processor");
}

const worker = createGenerationWorker(processor, {
  concurrency: parseInt(process.env.QUEUE_CONCURRENCY || "2", 10),
  maxPerSecond: parseInt(process.env.QUEUE_MAX_PER_SEC || "10", 10),
});

worker.on("completed", (job) => {
  console.log(`AI generation job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`AI generation job ${job?.id || "unknown"} failed:`, error.message);
});

worker.on("error", (error) => {
  console.error("Worker error:", error.message);
});

console.log("CollabDraw AI generation worker is running and listening for jobs");

// Graceful worker shutdown
const shutdown = async () => {
  console.log("Shutting down AI generation worker...");
  await worker.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);