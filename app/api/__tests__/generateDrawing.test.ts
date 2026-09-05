/**
 * POST /api/generate-drawing — the only route that spends money.
 *
 * Everything in it is a boundary: an unauthenticated request on one side, a paid
 * provider and an API key on the other, and a reply that is turned into shapes on
 * somebody's canvas. So the tests are about what reaches the model (a capped
 * transcript, a capped scene, an image only if it is really an image) and what
 * reaches the client (an intent, or a message that says what went wrong without
 * quoting the provider — a raw error from that side can name the base URL, the
 * model and the account).
 *
 * `resolveProvider` is the real one, driven by environment variables, since
 * "which provider did we pick" is exactly the kind of thing a mock would agree
 * with and production would not. Only the two network calls are replaced.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The two calls that would otherwise reach a provider. */
const model = vi.hoisted(() => ({
  calls: [] as { provider: unknown; call: Record<string, unknown> }[],
  streamed: [] as { provider: unknown; call: Record<string, unknown> }[],
  reply: "{}",
  fail: null as Error | null,
}));

const limiter = vi.hoisted(() => ({ allow: true, calls: [] as unknown[][] }));

vi.mock("../../services/ai/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/ai/llm")>()),
  completeDrawing: async (provider: unknown, call: Record<string, unknown>) => {
    model.calls.push({ provider, call });
    if (model.fail) throw model.fail;
    return model.reply;
  },
  streamDrawing: async (provider: unknown, call: Record<string, unknown>) => {
    model.streamed.push({ provider, call });
    if (model.fail) throw model.fail;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(model.reply));
        controller.close();
      },
    });
  },
}));

vi.mock("../../lib/rateLimit", () => ({
  isAllowedRateLimit: async (...args: unknown[]) => {
    limiter.calls.push(args);
    return limiter.allow;
  },
}));

import { MAX_EDGES, MAX_NODES } from "../../services/ai/graph";
import { CONFIG_ERROR_MESSAGE } from "../../services/ai/llm";
import { POST } from "../generate-drawing/route";

/** A reply the intent parser accepts, and one it does not. */
const DRAWABLE = JSON.stringify({
  title: "3x3 board",
  summary: "A board",
  placement: "add",
  kind: "grid",
  grid: { rows: 3, columns: 3, style: "board", headerRow: false, cells: [] },
});
const NOTHING_DRAWABLE = JSON.stringify({
  title: "Nothing",
  summary: "",
  kind: "scene",
  scene: { items: [] },
});

const request = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/generate-drawing", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const ask = (body: Record<string, unknown> = {}) =>
  request({ prompt: "draw a login flow", ...body });

/** The call the route assembled for the model. */
const sent = () => model.calls[0].call;

beforeEach(() => {
  // One key, one provider: the route only needs `resolveProvider` to say yes, and
  // the surrounding environment must not decide which one.
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  for (const name of [
    "AI_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_PROVIDER",
    "AI_BASE_URL",
    "AI_MODEL",
  ]) {
    vi.stubEnv(name, "");
  }
  model.calls.length = 0;
  model.streamed.length = 0;
  model.reply = DRAWABLE;
  model.fail = null;
  limiter.allow = true;
  limiter.calls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("before it will call a model", () => {
  it("says how to configure one when there is none", async () => {
    // The message names the variables, because the alternative is a deployment
    // where the assistant silently does nothing.
    vi.stubEnv("GEMINI_API_KEY", "");

    const response = await POST(ask());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: CONFIG_ERROR_MESSAGE });
    expect(model.calls).toEqual([]);
  });

  it("refuses a caller over the limit, before reading the body", async () => {
    limiter.allow = false;

    const response = await POST(ask());

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "Too many requests. Please wait a moment and try again.",
    });
    expect(model.calls).toEqual([]);
  });

  it("counts twenty a minute per client address", async () => {
    await POST(ask({}));
    expect(limiter.calls[0]).toEqual(["unknown", 20, 60]);

    limiter.calls.length = 0;
    await POST(request({ prompt: "x" }, { "x-real-ip": "198.51.100.9" }));
    expect(limiter.calls[0]).toEqual(["198.51.100.9", 20, 60]);

    limiter.calls.length = 0;
    await POST(
      request(
        { prompt: "x" },
        {
          // A proxy chain: the client is the first entry, and the rest are ours.
          "x-forwarded-for": " 203.0.113.7 , 10.0.0.1",
          "x-real-ip": "10.0.0.1",
        },
      ),
    );
    expect(limiter.calls[0]).toEqual(["203.0.113.7", 20, 60]);
  });

  it("refuses an oversized body on its declared length alone", async () => {
    // A 6 MiB ceiling read off `content-length`, so the request is turned away
    // before it is buffered — the base64 canvas snapshot is what makes this
    // reachable at all, and reading the body to find out how big it is defeats
    // the point of the cap.
    const oversized = ask({ image: "data:image/png;base64,iVBORw0KGgo=" });
    // `content-length` is a forbidden header on a `Request`, so the constructor
    // drops it; the header list has to be replaced on the instance instead.
    Object.defineProperty(oversized, "headers", {
      value: new Headers({
        "content-type": "application/json",
        "content-length": String(6 * 1024 * 1024 + 1),
      }),
    });

    const response = await POST(oversized);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Request body is too large.",
    });
    expect(model.calls).toEqual([]);
  });

  it("refuses a body it cannot read", async () => {
    const response = await POST(request("{not json"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Malformed request body." });
    expect(model.calls).toEqual([]);
  });

  it("asks for a prompt", async () => {
    for (const body of [{}, { prompt: "   " }, { prompt: 42 }]) {
      const response = await POST(request(body));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "A prompt is required." });
    }
    expect(model.calls).toEqual([]);
  });
});

describe("what it sends the model", () => {
  it("states the request and the canvas it applies to", async () => {
    await POST(ask());

    // The one rule the whole pipeline rests on: the model describes, the app
    // lays out. A model that starts emitting coordinates draws overlapping junk.
    expect(sent().system).toContain("You never give pixel coordinates");
    expect(sent().userText).toContain("Current canvas:");
    expect(sent().userText).toContain("Request: draw a login flow");
  });

  it("keeps the transcript to text turns, newest eight, user first", async () => {
    // Gemini rejects a transcript that opens on a model turn, and a long one
    // costs tokens on every request while the canvas already carries the state.
    await POST(
      ask({
        history: [
          { role: "model", parts: [{ text: "dropped: too old" }] },
          ...Array.from({ length: 9 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "model",
            parts: [{ text: `turn ${i}` }],
          })),
        ],
      }),
    );

    // The cap is applied first and the leading model turn is dropped after, so a
    // transcript can arrive shorter than eight: turns 1-8 are the newest eight,
    // and turn 1 is the model's.
    const history = sent().history as { role: string; text: string }[];
    expect(history).toHaveLength(7);
    expect(history[0]).toEqual({ role: "user", text: "turn 2" });
    expect(history.at(-1)).toEqual({ role: "user", text: "turn 8" });
  });

  it("drops junk turns rather than passing them on", async () => {
    await POST(
      ask({
        history: [
          null,
          "nope",
          { role: "user", parts: "not an array" },
          { role: "user", parts: [{ image: "no text" }] },
          { role: "user", parts: [{ text: "" }] },
          { role: "assistant", parts: [{ text: "role we do not know" }] },
        ],
      }),
    );

    expect(sent().history).toEqual([
      // An unknown role becomes "user" rather than being dropped: the text is
      // still part of the conversation.
      { role: "user", text: "role we do not know" },
    ]);
  });

  it("truncates a very long turn instead of refusing it", async () => {
    await POST(
      ask({ history: [{ role: "user", parts: [{ text: "T".repeat(5000) }] }] }),
    );

    expect((sent().history as { text: string }[])[0].text).toHaveLength(2000);
  });

  it("ignores a history that is not a list", async () => {
    await POST(ask({ history: { role: "user" } }));

    expect(sent().history).toEqual([]);
  });

  it("passes an image on and tells the model what it is", async () => {
    // A description cannot convey a freehand sketch, so the canvas is sent twice:
    // as structure, and as a picture.
    await POST(ask({ image: "data:image/png;base64,iVBORw0KGgo=" }));

    expect(sent().image).toEqual({
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(sent().userText).toContain("the canvas as it looks right now");
  });

  it("drops anything that is not an image we can send", async () => {
    // Dropped, not refused: the structured description alone still produces a
    // drawing, so a bad snapshot must not cost the user their request.
    for (const image of [
      undefined,
      null,
      42,
      "https://evil.example.com/pixel.png",
      "data:",
      "data:image/png;base64",
      "data:image/png,notbase64",
      "data:image/pngbase64,AAA",
      "data:image/gif;base64,R0lGOD",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      `data:image/png;base64,${"A".repeat(4_000_001)}`,
    ]) {
      model.calls.length = 0;

      const response = await POST(ask({ image }));

      expect(response.status).toBe(200);
      expect(sent().image).toBeNull();
      expect(sent().userText).not.toContain("the canvas as it looks right now");
    }
  });

  it("adds the system-design hint only for the caller that asks for it", async () => {
    // No UI sets `mode` any more — the panel's Architecture toggle is gone,
    // the classifier having already picked the kind — but the field is still
    // accepted, so the hint has to keep tracking it rather than the old toggle.
    await POST(ask({ mode: "system" }));
    expect(sent().userText).toContain("The caller asked for a system design");

    model.calls.length = 0;
    await POST(ask({ mode: "diagram" }));
    expect(sent().userText).not.toContain("The caller asked for a system design");
  });

  it("caps the scene it describes", async () => {
    // The scene comes from the client, and it is the largest thing in the prompt;
    // a runaway canvas would otherwise be billed one node at a time.
    await POST(
      ask({
        scene: {
          nodes: Array.from({ length: MAX_NODES + 20 }, (_, i) => ({
            id: `n${i}`,
            label: `Node ${i}`,
          })),
          edges: Array.from({ length: MAX_EDGES + 20 }, (_, i) => ({
            from: `n${i}`,
            to: `n${i + 1}`,
          })),
          items: Array.from({ length: 200 }, (_, i) => ({ id: `i${i}` })),
          otherCount: 12.9,
        },
      }),
    );

    expect(sent().userText).toContain("Current canvas:");
    // The count of what was left out is stated, as a whole number: the client
    // computes it, and a fraction of an element reads to the model as nonsense.
    expect(sent().userText).toContain("Plus 12 further element(s).");
    expect(model.calls).toHaveLength(1);
  });

  it("describes an empty canvas when the scene is unusable", async () => {
    for (const scene of [
      undefined,
      null,
      "nope",
      42,
      // An object of the right shape but the wrong types: every list is read
      // through `Array.isArray`, so a client mid-migration gets an empty
      // description rather than a 500.
      { nodes: null, edges: "none", items: 7, otherCount: -3 },
    ]) {
      model.calls.length = 0;

      const response = await POST(ask({ scene }));

      expect(response.status).toBe(200);
      expect(sent().userText).toContain("Current canvas:");
      expect(sent().userText).not.toContain("further element(s)");
    }
  });
});

describe("what it does with the reply", () => {
  it("answers with the intent it could parse", async () => {
    const response = await POST(ask());

    expect(response.status).toBe(200);
    const { intent } = await response.json();
    expect(intent.kind).toBe("grid");
    expect(intent.grid).toMatchObject({ rows: 3, columns: 3 });
  });

  it("lets the model address nodes that are already on the canvas", async () => {
    // Without the existing ids, an edge to one of them looks dangling and is
    // discarded — the model could add to a diagram but never connect to it.
    model.reply = JSON.stringify({
      title: "Connect",
      summary: "",
      kind: "diagram",
      diagram: {
        nodes: [{ id: "new-1", label: "Retry" }],
        edges: [{ from: "existing-1", to: "new-1" }],
      },
    });

    const response = await POST(
      ask({ scene: { nodes: [{ id: "existing-1", label: "Login" }] } }),
    );

    const { intent } = await response.json();
    expect(intent.diagram.edges).toHaveLength(1);
  });

  it("says the reply was unreadable when it is not JSON", async () => {
    // Should not happen under a response schema; a blocked or truncated reply is
    // the realistic cause, and it is not the user's fault.
    model.reply = "I'm sorry, I can't help with that.";

    const response = await POST(ask());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The assistant returned an unreadable reply. Please try again.",
    });
  });

  it("says nothing was drawable when the reply describes nothing", async () => {
    model.reply = NOTHING_DRAWABLE;

    const response = await POST(ask());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error:
        "The assistant did not describe anything drawable. Try rephrasing the request.",
    });
  });

  it("keeps the provider's own words out of the response", async () => {
    // A provider error can carry the base URL, the model name and account
    // details; the client gets a sentence, the server log gets the rest.
    model.fail = new Error(
      "401 Unauthorized from https://generativelanguage.googleapis.com: key AIza-secret",
    );

    const response = await POST(ask());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The assistant could not be reached. Please try again.",
    });
    expect(console.error).toHaveBeenCalledWith(
      "generate-drawing failed:",
      expect.stringContaining("401 Unauthorized"),
    );
  });

  it("handles a failure that is not an Error at all", async () => {
    model.fail = "just a string" as unknown as Error;

    const response = await POST(ask());

    expect(response.status).toBe(502);
    expect(console.error).toHaveBeenCalledWith(
      "generate-drawing failed:",
      "Unknown error from the model.",
    );
  });
});

describe("streaming", () => {
  it("hands the model's JSON back as it arrives, unparsed", async () => {
    // The client owns the builders and renders item by item, so the route must
    // not buffer the document to validate it first.
    const response = await POST(ask({ stream: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe(DRAWABLE);
    expect(model.calls).toEqual([]);
    expect(model.streamed).toHaveLength(1);
  });

  it("asks intermediaries not to buffer or cache it", async () => {
    // Without these a proxy holds the whole document and the incremental render
    // arrives all at once at the end.
    const response = await POST(ask({ stream: true }));

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("streams only when the client asks in so many words", async () => {
    await POST(ask({ stream: "yes" }));

    expect(model.streamed).toEqual([]);
    expect(model.calls).toHaveLength(1);
  });

  it("reports a failure before the first byte as a failure", async () => {
    model.fail = new Error("upstream connect error");

    const response = await POST(ask({ stream: true }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The assistant could not be reached. Please try again.",
    });
  });
});
