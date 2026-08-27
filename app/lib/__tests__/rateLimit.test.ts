import { describe, expect, it } from "vitest";
import { isAllowedRateLimit } from "../rateLimit";

describe("rateLimit", () => {
  it("allows requests under the limit", async () => {
    const key = `test-ip-${Date.now()}-1`;
    for (let i = 0; i < 5; i++) {
      const allowed = await isAllowedRateLimit(key, 5, 60);
      expect(allowed).toBe(true);
    }
  });

  it("blocks requests over the limit", async () => {
    const key = `test-ip-${Date.now()}-2`;
    for (let i = 0; i < 3; i++) {
      await isAllowedRateLimit(key, 3, 60);
    }
    const blocked = await isAllowedRateLimit(key, 3, 60);
    expect(blocked).toBe(false);
  });
});
