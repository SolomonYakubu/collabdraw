const Redis = require("ioredis");
const { createAdapter } = require("@socket.io/redis-adapter");
const config = require("./config");

let clients = null;

/**
 * Create Redis clients only when REDIS_URL is configured. Local development
 * continues to use the in-memory store; production should fail fast when
 * Redis is required by setting REQUIRE_REDIS=true.
 */
function initRedis() {
  if (!config.redisUrl) {
    if (config.requireRedis) {
      throw new Error("REDIS_URL is required when REQUIRE_REDIS=true");
    }
    console.warn("REDIS_URL is not configured; using in-memory state");
    return null;
  }

  const common = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
  const pub = new Redis(config.redisUrl, common);
  const sub = pub.duplicate();
  const state = pub.duplicate();

  for (const client of [pub, sub, state]) {
    client.on("error", (error) => {
      console.error("Redis connection error:", error.message);
    });
  }

  clients = { pub, sub, state };
  return clients;
}

function closeRedis() {
  if (!clients) return Promise.resolve();
  return Promise.all(Object.values(clients).map((client) => client.quit()));
}

function getStateClient() {
  return clients?.state || null;
}

function configureSocketAdapter(io, redisClients) {
  if (redisClients) {
    io.adapter(createAdapter(redisClients.pub, redisClients.sub));
  }
}

module.exports = {
  closeRedis,
  configureSocketAdapter,
  getStateClient,
  initRedis,
};
