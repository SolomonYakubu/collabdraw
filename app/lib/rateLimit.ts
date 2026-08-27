import Redis from "ioredis";

/**
 * Distributed rate limiter with in-memory fallback.
 *
 * When REDIS_URL is configured (e.g. Upstash or managed Redis), rate limiting
 * is synchronized across all Next.js instances. When unconfigured or unreachable,
 * a local in-memory Map is used.
 */

let redisClient: Redis | null = null;

function getRedis(): Redis | null {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  if (!redisClient) {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 3) return null; // Stop retrying on repeated failure
        return Math.min(times * 100, 1000);
      },
    });

    redisClient.on("error", (err) => {
      console.warn("Redis rate-limiter connection error:", err.message);
    });
  }

  return redisClient;
}

// In-memory fallback
const inMemoryBuckets = new Map<string, { count: number; resetAt: number }>();

function checkInMemoryLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const bucket = inMemoryBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    if (inMemoryBuckets.size > 10_000) {
      for (const [k, val] of inMemoryBuckets) {
        if (val.resetAt <= now) inMemoryBuckets.delete(k);
      }
    }
    inMemoryBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= maxRequests) {
    return false;
  }

  bucket.count += 1;
  return true;
}

/**
 * Check whether a given key (e.g. IP address) is within rate limits.
 * Returns `true` if the request is ALLOWED, `false` if RATE-LIMITED.
 */
export async function isAllowedRateLimit(
  key: string,
  maxRequests = 20,
  windowSeconds = 60,
): Promise<boolean> {
  const redis = getRedis();

  if (redis) {
    try {
      if (redis.status !== "ready" && redis.status !== "connecting") {
        await redis.connect().catch(() => {});
      }

      const redisKey = `collabdraw:ratelimit:${key}`;
      const results = await redis
        .pipeline()
        .incr(redisKey)
        .expire(redisKey, windowSeconds, "NX")
        .exec();

      if (results && results[0] && typeof results[0][1] === "number") {
        const count = results[0][1];
        return count <= maxRequests;
      }
    } catch {
      // Redis error: seamlessly fall through to in-memory fallback
    }
  }

  return checkInMemoryLimit(key, maxRequests, windowSeconds * 1000);
}
