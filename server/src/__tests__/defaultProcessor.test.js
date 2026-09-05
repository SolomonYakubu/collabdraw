/**
 * The job processor the queue worker runs.
 *
 * It is a placeholder for real generation work — the summary it returns is
 * assembled from the request, not from a model — but it is also the contract the
 * `/jobs/:jobId` response is built from, and it is what decides whether a bad job
 * fails loudly or quietly succeeds with nothing in it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import defaultProcessor from "../jobs/processors/defaultProcessor.js";

/** A BullMQ job, as far as this processor is concerned. */
const job = (data, id = "job-1") => ({
  id,
  data,
  updateProgress: vi.fn(async () => {}),
});

beforeEach(() => {
  // It logs the prompt it is starting on; the worker's output is not this suite's.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a job it can process", () => {
  it("answers with the request, resolved and stamped", async () => {
    const before = Date.now();

    const result = await defaultProcessor(
      job({ prompt: "a login flow", mode: "sequence", roomId: "r1", userId: "u1" }),
    );

    expect(result).toMatchObject({
      jobId: "job-1",
      prompt: "a login flow",
      mode: "sequence",
      roomId: "r1",
      userId: "u1",
      status: "completed",
      summary: "Processed diagram generation for: a login flow",
    });
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("fills in what the caller left out", async () => {
    const result = await defaultProcessor(job({ prompt: "a house" }));

    expect(result).toMatchObject({ mode: "diagram", roomId: null, userId: null });
  });

  it("trims the prompt it echoes back", async () => {
    const result = await defaultProcessor(job({ prompt: "  a house  " }));

    expect(result.prompt).toBe("a house");
    expect(result.summary).toBe("Processed diagram generation for: a house");
  });

  it("keeps the summary short enough to log", async () => {
    const result = await defaultProcessor(job({ prompt: "x".repeat(200) }));

    expect(result.summary).toHaveLength("Processed diagram generation for: ".length + 60);
  });

  it("reports progress from start to finish", async () => {
    // A job that never reports is indistinguishable from a stuck one, and the
    // status endpoint has nothing but this to show.
    const j = job({ prompt: "a house" });

    await defaultProcessor(j);

    expect(j.updateProgress.mock.calls.flat()).toEqual([10, 40, 100]);
  });
});

describe("a job it refuses", () => {
  const refused = async (data) => {
    await expect(defaultProcessor(job(data))).rejects.toThrow(
      "Job payload must contain a valid prompt string.",
    );
  };

  it("fails a job with no usable prompt, rather than inventing one", async () => {
    // BullMQ retries a rejection and records the reason; returning a result built
    // from `undefined` would look like a completed job that generated nothing.
    await refused({});
    await refused({ prompt: "" });
    await refused({ prompt: 42 });
    await refused(undefined);
  });

  it("fails before claiming to have started", async () => {
    // The reason reaches the client through `/jobs/:jobId`, so it has to be this
    // one rather than a TypeError from logging a prompt that is not a string.
    const j = job({ prompt: 42 });

    await expect(defaultProcessor(j)).rejects.toThrow(
      "Job payload must contain a valid prompt string.",
    );

    expect(j.updateProgress).not.toHaveBeenCalled();
  });
});
