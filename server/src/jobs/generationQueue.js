const { Queue, QueueEvents, Worker } = require("bullmq");
const Redis = require("ioredis");
const config = require("../config");

const QUEUE_NAME = "collabdraw:ai-generation";

const connection = () => {
  if (!config.redisUrl) {
    throw new Error("REDIS_URL is required to use the AI generation queue");
  }
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
};

/** Create the durable producer used by non-streaming/background generation. */
function createGenerationQueue() {
  const queue = new Queue(QUEUE_NAME, {
    connection: connection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    },
  });
  const events = new QueueEvents(QUEUE_NAME, { connection: connection() });
  return { queue, events };
}

/** Start a worker with an application-specific processor. */
function createGenerationWorker(processor, options = {}) {
  return new Worker(QUEUE_NAME, processor, {
    connection: connection(),
    concurrency: options.concurrency || 2,
    limiter: { max: options.maxPerSecond || 10, duration: 1_000 },
  });
}

module.exports = { QUEUE_NAME, createGenerationQueue, createGenerationWorker };