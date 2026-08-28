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
};
