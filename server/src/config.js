/**
 * Server configuration loaded from environment variables.
 *
 * CLIENT_ORIGIN must be set in production — defaulting to "*" would let any
 * site open a socket connection to the collaboration rooms, so the default is
 * the local app origin instead.
 */
module.exports = {
  port: parseInt(process.env.PORT || "3001", 10),
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
  isProduction: process.env.NODE_ENV === "production",
  redisUrl: process.env.REDIS_URL || "",
  requireRedis: process.env.REQUIRE_REDIS === "true",
  databaseUrl: process.env.DATABASE_URL || "",
  /**
   * How long the shutdown sequence gets before it stops waiting and exits.
   * Keep it under the platform's own grace period — the window between SIGTERM
   * and SIGKILL, 30s on Render and Heroku — so the last word is ours and the
   * log says what was stuck.
   */
  shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS || "10000", 10),
};
