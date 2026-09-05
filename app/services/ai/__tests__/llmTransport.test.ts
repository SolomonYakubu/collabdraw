/**
 * The transports underneath the AI route: `completeDrawing` and `streamDrawing`.
 *
 * The route decides *what* to ask for; this layer decides what actually goes on
 * the wire, and it is the half no other test sees — a mistake here does not throw
 * anywhere, it quietly sends the model a schema it ignores, a transcript in the
 * wrong vocabulary, or an image the provider drops, and the visible symptom is
 * only that the drawing comes out wrong. So these tests read the request that
 * would have left the process, for both dialects the app speaks: Gemini's SDK
 * and the OpenAI-compatible `/chat/completions` contract that covers everyone
 * else.
 *
 * Only the two seams are faked — the `GoogleGenAI` client and `fetch`. The
 * schema translation, the SSE flattening and the error handling are the real
 * ones, which is the point: the streaming reassembly used to be tested against a
 * copy of the loop kept "in sync" by hand, and a copy cannot fail when the
 * original does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in for the Gemini SDK, recording what the transport asked it for. */
const gemini = vi.hoisted(() => {
  const state = {
    keys: [] as unknown[],
    chats: [] as Record<string, unknown>[],
    sent: [] as unknown[],
    streamed: [] as unknown[],
    reply: {} as Record<string, unknown>,
    pieces: [] as (string | undefined)[],
    /** Index at which the async iteration throws, as a dropped socket would. */
    failsAt: -1,
  };

  class FakeGoogleGenAI {
    constructor(options: { apiKey?: string }) {
      state.keys.push(options.apiKey);
    }

    chats = {
      create: (config: Record<string, unknown>) => {
        state.chats.push(config);
        return {
          sendMessage: async (args: unknown) => {
            state.sent.push(args);
            return state.reply;
          },
          sendMessageStream: async (args: unknown) => {
            state.streamed.push(args);
            return (async function* stream() {
              for (const [index, text] of state.pieces.entries()) {
                if (index === state.failsAt) {
                  throw new Error("stream closed by peer");
                }
                yield { text };
              }
            })();
          },
        };
      },
    };
  }

  return { state, FakeGoogleGenAI };
});

vi.mock("@google/genai", async (importOriginal) => ({
  // The real enums, so the assertions below name the values the SDK will see.
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: gemini.FakeGoogleGenAI,
}));

import {
  HarmBlockThreshold,
  HarmCategory,
  Type,
  type Schema,
} from "@google/genai";

import {
  completeDrawing,
  streamDrawing,
  type ModelCall,
  type ModelOptions,
} from "../llm";

/** Every request the transport made, and the replies waiting for it. */
const http = {
  calls: [] as { url: string; init: RequestInit }[],
  queue: [] as Response[],
};

const respondWith = (...responses: Response[]) => {
  http.queue = responses;
};

const jsonReply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const completion = (content: string) =>
  jsonReply({ choices: [{ message: { content } }] });

const sseReply = (chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );

/** The body of the nth request, as the provider would parse it. */
const bodyOf = (index: number) =>
  JSON.parse(String(http.calls[index].init.body)) as Record<string, unknown>;

const readAll = async (stream: ReadableStream<Uint8Array>) =>
  new Response(stream).text();

const GEMINI = {
  id: "gemini",
  apiKey: "g-key",
  baseUrl: "",
  model: "gemini-3.1-flash-lite",
} as const;

const OPENAI = {
  id: "openai",
  apiKey: "o-key",
  // Trailing slashes are stripped by `resolveProvider`, so the transport can
  // append the path without producing a double slash.
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
} as const;

const CALL: ModelCall = {
  system: "You draw on a whiteboard.",
  history: [
    { role: "user", text: "draw a login flow" },
    { role: "model", text: "{...}" },
  ],
  userText: "Request: add a retry step",
  image: null,
};

const IMAGE = { mimeType: "image/png", data: "iVBORw0KGgo=" };

/** One of each construct the translation has to handle. */
const OPTIONS: ModelOptions = {
  schema: {
    type: "object",
    required: ["kind"],
    properties: {
      kind: { type: "string", enum: ["grid", "diagram"] },
      count: { type: "integer", description: "how many" },
      items: {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" } } },
      },
    },
  },
};

beforeEach(() => {
  gemini.state.keys.length = 0;
  gemini.state.chats.length = 0;
  gemini.state.sent.length = 0;
  gemini.state.streamed.length = 0;
  gemini.state.reply = { text: "{}" };
  gemini.state.pieces = [];
  gemini.state.failsAt = -1;
  http.calls.length = 0;
  http.queue = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    http.calls.push({ url: String(url), init });
    return http.queue.shift() ?? completion("{}");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Gemini transport", () => {
  /** The chat configuration the SDK was handed. */
  const chat = () => gemini.state.chats[0];
  const config = () => chat().config as Record<string, unknown>;

  it("carries the key on the client rather than a global", async () => {
    // The key comes from `resolveProvider`, so a transport that read the
    // environment itself could reach a different provider than the route chose.
    await completeDrawing(GEMINI, CALL, OPTIONS);

    expect(gemini.state.keys).toEqual(["g-key"]);
    expect(chat().model).toBe("gemini-3.1-flash-lite");
  });

  it("enforces the reply schema on the provider's side", async () => {
    // The strongest guarantee available: a schema the model cannot answer around,
    // rather than a prompt asking it politely for JSON.
    await completeDrawing(GEMINI, CALL, OPTIONS);

    expect(config().systemInstruction).toBe(CALL.system);
    expect(config().responseMimeType).toBe("application/json");
    expect(config().temperature).toBe(0.2);
    expect(config().maxOutputTokens).toBe(8192);
  });

  it("relaxes the safety filters to the highest threshold", async () => {
    // Diagrams of security systems, weapons and outages read as harmful to a
    // default filter, and a blocked reply is an empty canvas.
    await completeDrawing(GEMINI, CALL, OPTIONS);

    expect(config().safetySettings).toEqual([
      HarmCategory.HARM_CATEGORY_HARASSMENT,
      HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    ].map((category) => ({
      category,
      threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
    })));
  });

  it("translates the schema into Gemini's dialect", async () => {
    // Gemini wants its own uppercase type enum and marks a closed set with
    // `format: "enum"`; the route states the schema once, in JSON Schema.
    await completeDrawing(GEMINI, CALL, OPTIONS);

    expect(config().responseSchema).toEqual({
      type: Type.OBJECT,
      required: ["kind"],
      properties: {
        kind: {
          type: Type.STRING,
          enum: ["grid", "diagram"],
          format: "enum",
        },
        count: { type: Type.INTEGER, description: "how many" },
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: { label: { type: Type.STRING } },
          },
        },
      },
    } satisfies Schema);
  });

  it("keeps a plain format hint when there is no enum", async () => {
    // `format: "enum"` is Gemini's marker for a closed set, so it is only ever
    // written from an `enum`; any other format the route states is passed on.
    await completeDrawing(GEMINI, CALL, {
      schema: { type: "string", format: "date-time" },
    });

    expect(config().responseSchema).toEqual({
      type: Type.STRING,
      format: "date-time",
    });
  });

  it("falls back to an object for a schema it cannot read", async () => {
    // A malformed or unknown node becomes a permissive object rather than an
    // invalid schema the API would reject outright.
    await completeDrawing(GEMINI, CALL, {
      schema: { type: "tuple", properties: { a: "not a node" } },
    });

    expect(config().responseSchema).toEqual({
      type: Type.OBJECT,
      properties: { a: { type: Type.OBJECT, properties: {} } },
    });
  });

  it("lets the caller set the sampling budget", async () => {
    await completeDrawing(GEMINI, CALL, {
      ...OPTIONS,
      temperature: 0.9,
      maxOutputTokens: 256,
    });

    expect(config().temperature).toBe(0.9);
    expect(config().maxOutputTokens).toBe(256);
  });

  it("sends prior turns in the vocabulary Gemini uses", async () => {
    await completeDrawing(GEMINI, CALL, OPTIONS);

    expect(chat().history).toEqual([
      { role: "user", parts: [{ text: "draw a login flow" }] },
      { role: "model", parts: [{ text: "{...}" }] },
    ]);
  });

  it("sends the request as plain text when there is no image", async () => {
    await completeDrawing(GEMINI, CALL, OPTIONS);

    expect(gemini.state.sent).toEqual([
      { message: "Request: add a retry step" },
    ]);
  });

  it("attaches the canvas image and says what it is", async () => {
    // Without the sentence the model treats the picture as the subject to draw
    // rather than as the canvas it is editing.
    await completeDrawing(GEMINI, { ...CALL, image: IMAGE }, OPTIONS);

    expect(gemini.state.sent).toEqual([
      {
        message: [
          {
            text:
              "The attached image shows the canvas as it looks right now.\n\n" +
              "Request: add a retry step",
          },
          { inlineData: IMAGE },
        ],
      },
    ]);
  });

  it("returns the reply text", async () => {
    gemini.state.reply = { text: '{"kind":"grid"}' };

    expect(await completeDrawing(GEMINI, CALL, OPTIONS)).toBe('{"kind":"grid"}');
  });

  it("answers with nothing when the model returned no text", async () => {
    // The route parses the result, so "" becomes its own "unreadable reply"
    // error rather than a crash on undefined here.
    gemini.state.reply = {};

    expect(await completeDrawing(GEMINI, CALL, OPTIONS)).toBe("");
  });

  it("names the reason when the prompt itself was blocked", async () => {
    // A blocked prompt returns a 200 with no text, which is otherwise
    // indistinguishable from a model that had nothing to say.
    gemini.state.reply = { promptFeedback: { blockReason: "SAFETY" } };

    await expect(completeDrawing(GEMINI, CALL, OPTIONS)).rejects.toThrow(
      "The request was blocked (SAFETY).",
    );
  });
});

describe("streaming from Gemini", () => {
  it("passes the pieces through in order and skips the empty ones", async () => {
    // The client parses the JSON as it grows, so an empty chunk enqueued as a
    // zero-length write is noise it should never see.
    gemini.state.pieces = ['{"kind"', undefined, ':"grid"}'];

    const stream = await streamDrawing(GEMINI, CALL, OPTIONS);

    expect(await readAll(stream)).toBe('{"kind":"grid"}');
    expect(gemini.state.streamed).toEqual([
      { message: "Request: add a retry step" },
    ]);
  });

  it("ends the body at a mid-stream failure instead of rejecting", async () => {
    // The response headers are already sent by then, so there is no status left
    // to change: the client sees a truncated document and says so itself.
    gemini.state.pieces = ['{"kind":', '"grid"}'];
    gemini.state.failsAt = 1;

    const stream = await streamDrawing(GEMINI, CALL, OPTIONS);

    expect(await readAll(stream)).toBe('{"kind":');
  });
});

describe("the OpenAI-compatible transport", () => {
  it("posts the completion to the configured base URL", async () => {
    await completeDrawing(OPENAI, CALL, OPTIONS);

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(http.calls[0].init.method).toBe("POST");
    expect(http.calls[0].init.headers).toEqual({
      Authorization: "Bearer o-key",
      "Content-Type": "application/json",
      // Attribution OpenRouter asks of its callers; everyone else ignores it.
      "HTTP-Referer": "https://collabdraw.local",
      "X-Title": "CollabDraw",
    });
  });

  it("asks for JSON matching the schema, in JSON Schema's own dialect", async () => {
    await completeDrawing(OPENAI, CALL, OPTIONS);

    expect(bodyOf(0).response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "drawing_intent",
        // Not strict: strict mode requires every property to be required, which
        // the intent schema deliberately is not.
        strict: false,
        schema: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["grid", "diagram"] },
            count: { type: "integer", description: "how many" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" } },
              },
            },
          },
        },
      },
    });
  });

  it("doubles the token budget and turns reasoning off", async () => {
    // A reasoning model spends the budget on invisible thinking and then
    // truncates the JSON mid-document; both settings are about that failure.
    await completeDrawing(OPENAI, CALL, OPTIONS);

    expect(bodyOf(0).max_tokens).toBe(16_384);
    expect(bodyOf(0).reasoning).toEqual({ enabled: false });
    expect(bodyOf(0).temperature).toBe(0.2);
    expect(bodyOf(0).model).toBe("gpt-4o-mini");

    await completeDrawing(OPENAI, CALL, { ...OPTIONS, maxOutputTokens: 100 });
    expect(bodyOf(1).max_tokens).toBe(200);
  });

  it("maps the transcript onto system, assistant and user roles", async () => {
    // "model" is Gemini's word for it; sending it here is a 400 from OpenAI.
    await completeDrawing(OPENAI, CALL, OPTIONS);

    expect(bodyOf(0).messages).toEqual([
      { role: "system", content: "You draw on a whiteboard." },
      { role: "user", content: "draw a login flow" },
      { role: "assistant", content: "{...}" },
      { role: "user", content: "Request: add a retry step" },
    ]);
  });

  it("sends the canvas image as an inline data URL part", async () => {
    await completeDrawing(OPENAI, { ...CALL, image: IMAGE }, OPTIONS);

    expect((bodyOf(0).messages as unknown[]).at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Request: add a retry step" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
        },
      ],
    });
  });

  it("falls back to an object for a schema it cannot read", async () => {
    // Same rule as the Gemini side: a permissive object beats a schema the API
    // would reject, since the route validates the reply either way.
    await completeDrawing(OPENAI, CALL, {
      schema: { type: "tuple", properties: { a: null } },
    });

    expect(
      (bodyOf(0).response_format as { json_schema: { schema: unknown } })
        .json_schema.schema,
    ).toEqual({ type: "object", properties: { a: { type: "object" } } });
  });

  it("returns the first choice's content, or nothing at all", async () => {
    respondWith(completion('{"kind":"grid"}'), jsonReply({ choices: [] }));

    expect(await completeDrawing(OPENAI, CALL, OPTIONS)).toBe('{"kind":"grid"}');
    expect(await completeDrawing(OPENAI, CALL, OPTIONS)).toBe("");
  });
});

describe("when an OpenAI-compatible provider refuses", () => {
  it("reports the provider's own message", async () => {
    respondWith(
      jsonReply({ error: { message: "Insufficient credit." } }, 402),
    );

    await expect(completeDrawing(OPENAI, CALL, OPTIONS)).rejects.toThrow(
      "Insufficient credit.",
    );
  });

  it("reads an error given as a bare string", async () => {
    // Ollama and several proxies answer with `{"error":"..."}`.
    respondWith(jsonReply({ error: "model not found" }, 404));

    await expect(completeDrawing(OPENAI, CALL, OPTIONS)).rejects.toThrow(
      "model not found",
    );
  });

  it("falls back to the status when the body explains nothing", async () => {
    // A gateway's HTML error page, or an empty 502 — the status is all there is.
    respondWith(new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    await expect(completeDrawing(OPENAI, CALL, OPTIONS)).rejects.toThrow(
      "The model provider returned status 502.",
    );
  });

  it("falls back to the status for a JSON error with nothing in it", async () => {
    // Well-formed JSON, no message: some proxies answer `{"error":{}}`.
    respondWith(jsonReply({ error: {} }, 500));

    await expect(completeDrawing(OPENAI, CALL, OPTIONS)).rejects.toThrow(
      "The model provider returned status 500.",
    );
  });

  it("retries without the response format when that is what was rejected", async () => {
    // Some hosted models reject `json_schema` outright. Dropping it costs the
    // server-side guarantee, not the feature: the route parses defensively.
    respondWith(
      jsonReply(
        { error: { message: "response_format is not supported" } },
        400,
      ),
      completion('{"kind":"grid"}'),
    );

    expect(await completeDrawing(OPENAI, CALL, OPTIONS)).toBe('{"kind":"grid"}');

    expect(http.calls).toHaveLength(2);
    expect(bodyOf(1).response_format).toBeUndefined();
    // Everything else survives the retry, including the prompt itself.
    expect(bodyOf(1).messages).toEqual(bodyOf(0).messages);
    expect(bodyOf(1).reasoning).toEqual({ enabled: false });
  });

  it("does not retry a 400 that is about something else", async () => {
    // A retry would double the cost of every bad request and hide the reason.
    respondWith(
      jsonReply({ error: { message: "context length exceeded" } }, 400),
    );

    await expect(completeDrawing(OPENAI, CALL, OPTIONS)).rejects.toThrow(
      "context length exceeded",
    );
    expect(http.calls).toHaveLength(1);
  });
});

/**
 * The upstream stream is SSE; what the client gets is the raw JSON text, so the
 * app's incremental parser does not need to know which provider answered.
 */
describe("streaming from an OpenAI-compatible provider", () => {
  const delta = (content: string) =>
    `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: null }],
    })}\n`;

  it("asks for a stream and flattens the deltas into the reply text", async () => {
    respondWith(
      sseReply([
        // A keep-alive comment, an empty data line, the role-only first delta
        // and the terminator all have to pass through without adding a byte to
        // the document.
        ": OPENROUTER PROCESSING\n\n",
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n',
        delta("{"),
        "data:\n",
        delta('"kind":"grid"'),
        delta("}"),
        "data: [DONE]\n",
      ]),
    );

    const stream = await streamDrawing(OPENAI, CALL, OPTIONS);

    expect(await readAll(stream)).toBe('{"kind":"grid"}');
    expect(bodyOf(0).stream).toBe(true);
  });

  it("reassembles a data line split across network chunks", async () => {
    // The failure this prevents: splitting each chunk on "\n" on its own drops
    // every delta the provider happened to cut in half, which the user sees as a
    // spinner that never finishes.
    respondWith(sseReply([...(delta("hello") + delta("world"))]));

    const stream = await streamDrawing(OPENAI, CALL, OPTIONS);

    expect(await readAll(stream)).toBe("helloworld");
  });

  it("skips a line it cannot parse and keeps the rest", async () => {
    respondWith(
      sseReply([delta("{"), "data: {not json}\n", delta("}"), "data: [DONE]\n"]),
    );

    const stream = await streamDrawing(OPENAI, CALL, OPTIONS);

    expect(await readAll(stream)).toBe("{}");
  });

  it("fails before the first byte when the provider refuses", async () => {
    // Nothing has been written yet, so this can still be a 502 with a message
    // rather than an empty body.
    respondWith(jsonReply({ error: { message: "No endpoints found." } }, 404));

    await expect(streamDrawing(OPENAI, CALL, OPTIONS)).rejects.toThrow(
      "No endpoints found.",
    );
  });

  it("fails when a 200 arrives with no body to read", async () => {
    respondWith(new Response(null, { status: 200 }));

    await expect(streamDrawing(OPENAI, CALL, OPTIONS)).rejects.toThrow(
      "The model provider returned status 200.",
    );
  });

  it("ends the body when the connection breaks mid-stream", async () => {
    // Past the headers there is no status left to send, so the reply simply stops
    // and the client's parse of the partial document reports it. The break has to
    // land on a later read: a stream errored before anything is read discards its
    // queue, which is a different failure from a socket dying halfway.
    let reads = 0;
    respondWith(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            reads += 1;
            if (reads === 1) {
              controller.enqueue(new TextEncoder().encode(delta('{"kind":')));
              return;
            }
            controller.error(new Error("ECONNRESET"));
          },
        }),
        { status: 200 },
      ),
    );

    const stream = await streamDrawing(OPENAI, CALL, OPTIONS);

    expect(await readAll(stream)).toBe('{"kind":');
  });

  it("stops reading upstream when the client goes away", async () => {
    // A cancelled fetch is the only thing that stops the provider billing for
    // tokens nobody will see.
    let cancelled = false;
    respondWith(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(delta("{")));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    );

    const stream = await streamDrawing(OPENAI, CALL, OPTIONS);
    await stream.cancel();

    expect(cancelled).toBe(true);
  });
});
