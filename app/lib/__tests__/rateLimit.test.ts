/**
 * The rate limiter with no `REDIS_URL` — the configuration the project runs in by
 * default, where counting happens in a `Map` inside the process.
 *
 * Its ceilings are the only thing standing in front of a paid AI provider and of
 * unbounded board creation, so what matters here is that a bucket really does
 * reset when its window ends (a limiter that never forgets locks a visitor out
 * permanently), that keys cannot borrow each other's allowance, and that the
 * sweep which keeps the map from growing forever cannot be used to clear a
 * bucket that is still counting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // A Vitest worker is shared with the suite that configures Redis; this file is
  // about the fallback, so make sure there is nothing to fall back from.
  delete process.env.REDIS_URL;
});

import { isAllowedRateLimit } from "../rateLimit";

/** A key nothing else in the file (or the module's surviving state) can touch. */
let counter = 0;
const freshKey = () => `test-key-${Date.now()}-${(counter += 1)}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("counting in memory", () => {
  it("allows requests up to the limit", async () => {
    const key = freshKey();

    for (let i = 0; i < 5; i += 1) {
      expect(await isAllowedRateLimit(key, 5, 60)).toBe(true);
    }
  });

  it("blocks the one after that", async () => {
    const key = freshKey();
    for (let i = 0; i < 3; i += 1) {
      await isAllowedRateLimit(key, 3, 60);
    }

    expect(await isAllowedRateLimit(key, 3, 60)).toBe(false);
  });

  it("keeps each key's allowance to itself", async () => {
    // The key carries the client address, so a shared count would let one
    // visitor's burst lock out everybody else.
    const noisy = freshKey();
    const quiet = freshKey();
    await isAllowedRateLimit(noisy, 1, 60);

    expect(await isAllowedRateLimit(noisy, 1, 60)).toBe(false);
    expect(await isAllowedRateLimit(quiet, 1, 60)).toBe(true);
  });

  it("forgets a bucket once its window has passed", async () => {
    // Without this the first burst of the process would ban an address for as
    // long as the server runs.
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const key = freshKey();
    await isAllowedRateLimit(key, 1, 60);
    expect(await isAllowedRateLimit(key, 1, 60)).toBe(false);

    vi.setSystemTime(1_700_000_060_001);

    expect(await isAllowedRateLimit(key, 1, 60)).toBe(true);
  });

  it("holds the line right up to the edge of the window", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const key = freshKey();
    await isAllowedRateLimit(key, 1, 60);

    vi.setSystemTime(1_700_000_059_999);

    expect(await isAllowedRateLimit(key, 1, 60)).toBe(false);
  });
});

describe("keeping the map from growing forever", () => {
  it("sweeps expired buckets without releasing one that is still counting", async () => {
    // The sweep runs only past 10,000 buckets, which an attacker can arrange by
    // rotating addresses. If it dropped live buckets too, that rotation would be
    // a way to clear their own limit.
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const victim = freshKey();
    await isAllowedRateLimit(victim, 1, 3600);
    expect(await isAllowedRateLimit(victim, 1, 3600)).toBe(false);

    for (let i = 0; i < 10_001; i += 1) {
      await isAllowedRateLimit(`sweep-${i}`, 1, 1);
    }
    // Every one of those has expired; the victim's hour-long window has not.
    vi.setSystemTime(1_700_000_002_000);
    await isAllowedRateLimit("sweep-trigger", 1, 1);

    expect(await isAllowedRateLimit(victim, 1, 3600)).toBe(false);
  });
});
