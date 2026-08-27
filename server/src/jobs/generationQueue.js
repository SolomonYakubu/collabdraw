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

let queueInstance = null;
let queueEventsInstance = null;

function getGenerationQueue() {
  if (!config.redisUrl) {
    return null;
  }
  if (!queueInstance) {
    const conn = connection();
    queueInstance = new Queue(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    });
    queueEventsInstance = new QueueEvents(QUEUE_NAME, { connection: connection() });
  }
  return queueInstance;
}

/**
 * Add an AI drawing generation job to the queue.
 */
async function enqueueGenerationJob(data) {
  const q = getGenerationQueue();
  if (!q) {
    throw new Error("Redis queue is not available. Please configure REDIS_URL.");
  }

  const job = await q.add("generate-drawing", data, {
    priority: data.priority || 5,
  });

  return {
    id: job.id,
    name: job.name,
    timestamp: job.timestamp,
  };
}

/**
 * Get job status, progress, and result by ID.
 */
async function getGenerationJob(jobId) {
  const q = getGenerationQueue();
  if (!q) {
    return null;
  }

  const job = await q.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  return {
    id: job.id,
    state,
    progress: job.progress,
    result: job.returnvalue || null,
    error: job.failedReason || null,
    timestamp: job.timestamp,
  };
}

async function closeGenerationQueue() {
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
  if (queueEventsInstance) {
    await queueEventsInstance.close();
    queueEventsInstance = null;
  }
}

module.exports = {
  QUEUE_NAME,
  closeGenerationQueue,
  createGenerationQueue,
  createGenerationWorker,
  enqueueGenerationJob,
  getGenerationJob,
  getGenerationQueue,
};