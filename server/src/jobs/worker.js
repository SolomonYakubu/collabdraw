const { createGenerationWorker } = require("./generationQueue");

const processorModule = process.env.GENERATION_PROCESSOR_MODULE;

if (!processorModule) {
  throw new Error(
    "GENERATION_PROCESSOR_MODULE must point to the deployed AI job processor",
  );
}

const processor = require(processorModule);
const worker = createGenerationWorker(processor);

worker.on("completed", (job) => {
  console.log(`AI generation job ${job.id} completed`);
});
worker.on("failed", (job, error) => {
  console.error(`AI generation job ${job?.id || "unknown"} failed:`, error.message);
});

console.log("CollabDraw AI generation worker is running");