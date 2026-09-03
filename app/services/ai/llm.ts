/**
 * Vendor-neutral transport for the drawing model.
 *
 * Everything domain-shaped — the prompt, the reply schema, validation — lives in
 * the route; this file only knows how to ship a chat completion to *some* model
 * and hand the text back. Two transports cover effectively every provider:
 *
 *  - Gemini, via the `@google/genai` SDK (structured-output schema enforced
 *    server-side).
 *  - Anything speaking the OpenAI-compatible `/chat/completions` contract,
 *    which is OpenAI, OpenRouter, Groq, Together, Mistral, DeepSeek, and
 *    self-hosted servers like Ollama and LM Studio.
 *
 * The provider is chosen from the environment; whichever key is present wins,
 * so switching vendors is a .env change, not a code change.
 */
import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Type,
  type Part,
  type Schema,
} from "@google/genai";

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export type ProviderId = "gemini" | "openai" | "openrouter" | "custom";

interface ProviderConfig {
  id: ProviderId;
  apiKey: string;
  /** OpenAI-compatible base URL; unused by the Gemini SDK path. */
  baseUrl: string;
  model: string;
}

const DEFAULT_MODELS: Record<ProviderId, string> = {
  gemini: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
  openai: "gpt-4o-mini",
  // OpenRouter routes many vendors; a concrete cheap default beats "auto",
  // whose behaviour changes underfoot.
  openrouter: "openai/gpt-4o-mini",
  custom: "",
};

const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  gemini: "",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  custom: "",
};

/** Explicit setting wins; otherwise the first configured key picks the vendor. */
export const resolveProvider = (): ProviderConfig | null => {
  const apiKey =
    process.env.AI_API_KEY?.trim() ||
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    "";

  if (!apiKey) {
    return null;
  }

  const requested = process.env.AI_PROVIDER?.trim().toLowerCase();
  const id = (
    requested && ["gemini", "openai", "openrouter", "custom"].includes(requested)
      ? requested
      : apiKey === process.env.OPENROUTER_API_KEY?.trim()
        ? "openrouter"
        : apiKey === process.env.OPENAI_API_KEY?.trim()
          ? "openai"
          : "gemini"
  ) as ProviderId;

  const baseUrl = (
    process.env.AI_BASE_URL?.trim() || DEFAULT_BASE_URLS[id]
  ).replace(/\/+$/, "");

  if (id === "custom" && !baseUrl) {
    return null;
  }

  return {
    id,
    apiKey,
    baseUrl,
    model: process.env.AI_MODEL?.trim() || DEFAULT_MODELS[id],
  };
};

/** Shown when no provider is configured, so setup is guessable from the error. */
export const CONFIG_ERROR_MESSAGE =
  "The AI assistant is not configured. Set one of GEMINI_API_KEY, OPENAI_API_KEY " +
  "or OPENROUTER_API_KEY (or AI_API_KEY with AI_PROVIDER=custom and AI_BASE_URL). " +
  "AI_MODEL overrides the default model.";

/* ------------------------------------------------------------------ *
 * Request shape (shared by every transport)
 * ------------------------------------------------------------------ */

export interface HistoryTurn {
  role: "user" | "model";
  text: string;
}

export interface ImagePart {
  mimeType: string;
  data: string;
}

export interface ModelCall {
  system: string;
  history: HistoryTurn[];
  userText: string;
  image: ImagePart | null;
}

export interface ModelOptions {
  /**
   * The reply schema, in either Gemini format (uppercase types) or plain JSON
   * Schema (lowercase); each transport normalises what it needs.
   */
  schema: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

/* ------------------------------------------------------------------ *
 * Schema conversion
 *
 * The route states the schema once. Gemini wants uppercase types and marks
 * enums with format: "enum"; OpenAI-compatible APIs want standard JSON Schema.
 * Both directions are mechanical, so neither transport needs its own copy.
 * ------------------------------------------------------------------ */

const GEMINI_TYPES: Record<string, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

const JSON_TYPES: Record<string, string> = {
  STRING: "string",
  NUMBER: "number",
  INTEGER: "integer",
  BOOLEAN: "boolean",
  ARRAY: "array",
  OBJECT: "object",
};

const toGeminiSchema = (node: unknown): Schema => {
  if (!node || typeof node !== "object") {
    return { type: Type.OBJECT, properties: {} };
  }

  const source = node as Record<string, unknown>;
  const result: Schema = {
    type: GEMINI_TYPES[String(source.type).toLowerCase()] ?? Type.OBJECT,
  };

  if (typeof source.description === "string") {
    result.description = source.description;
  }
  if (Array.isArray(source.enum)) {
    result.enum = source.enum.map(String);
    result.format = "enum";
  } else if (typeof source.format === "string") {
    result.format = source.format;
  }
  if (Array.isArray(source.required)) {
    result.required = source.required.map(String);
  }
  if (source.items) {
    result.items = toGeminiSchema(source.items);
  }
  if (source.properties && typeof source.properties === "object") {
    const properties: Record<string, Schema> = {};
    for (const [key, value] of Object.entries(
      source.properties as Record<string, unknown>,
    )) {
      properties[key] = toGeminiSchema(value);
    }
    result.properties = properties;
  }

  return result;
};

const toJsonSchema = (node: unknown): Record<string, unknown> => {
  if (!node || typeof node !== "object") {
    return { type: "object" };
  }

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {
    type: JSON_TYPES[String(source.type).toUpperCase()] ?? "object",
  };

  if (typeof source.description === "string") {
    result.description = source.description;
  }
  if (Array.isArray(source.enum)) {
    result.enum = source.enum;
  }
  if (Array.isArray(source.required)) {
    result.required = source.required;
  }
  if (source.items) {
    result.items = toJsonSchema(source.items);
  }
  if (source.properties && typeof source.properties === "object") {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      source.properties as Record<string, unknown>,
    )) {
      properties[key] = toJsonSchema(value);
    }
    result.properties = properties;
  }

  return result;
};

/* ------------------------------------------------------------------ *
 * Gemini transport
 * ------------------------------------------------------------------ */

const SAFETY_SETTINGS = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({
  category,
  threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
}));

const geminiContent = (call: ModelCall): string | Part[] => {
  const text = [
    call.image
      ? "The attached image shows the canvas as it looks right now."
      : null,
    call.userText,
  ]
    .filter(Boolean)
    .join("\n\n");

  return call.image ? [{ text }, { inlineData: call.image }] : text;
};

const geminiHistory = (history: readonly HistoryTurn[]) =>
  history.map((turn) => ({
    role: turn.role,
    parts: [{ text: turn.text }],
  }));

/**
 * A chat session carrying the whole call: the system instruction, the prior
 * turns and the enforced reply schema. Both the one-shot and streaming paths
 * send their message through one of these.
 */
const geminiChat = (
  provider: ProviderConfig,
  call: ModelCall,
  options: ModelOptions,
) =>
  new GoogleGenAI({ apiKey: provider.apiKey }).chats.create({
    model: provider.model,
    history: geminiHistory(call.history),
    config: {
      systemInstruction: call.system,
      safetySettings: SAFETY_SETTINGS,
      responseMimeType: "application/json",
      responseSchema: toGeminiSchema(options.schema),
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxOutputTokens ?? 8192,
    },
  });

/* ------------------------------------------------------------------ *
 * OpenAI-compatible transport (OpenAI, OpenRouter, Groq, Ollama, ...)
 * ------------------------------------------------------------------ */

const openAiMessages = (call: ModelCall) => {
  const messages: unknown[] = [
    { role: "system", content: call.system },
    ...call.history.map((turn) => ({
      role: turn.role === "model" ? "assistant" : "user",
      content: turn.text,
    })),
  ];

  messages.push({
    role: "user",
    content: call.image
      ? [
          { type: "text", text: call.userText },
          {
            type: "image_url",
            image_url: {
              url: `data:${call.image.mimeType};base64,${call.image.data}`,
            },
          },
        ]
      : call.userText,
  });

  return messages;
};

const openAiHeaders = (provider: ProviderConfig): Record<string, string> => ({
  Authorization: `Bearer ${provider.apiKey}`,
  "Content-Type": "application/json",
  // Optional attribution OpenRouter asks for; every other host ignores these.
  "HTTP-Referer": "https://collabdraw.local",
  "X-Title": "CollabDraw",
});

/**
 * Some models reject `response_format: json_schema`; that must not break the
 * feature, so a refusal of the *format* (not of the request generally) falls
 * back to prompting for JSON and parsing defensively downstream.
 */
const rejectedResponseFormat = (status: number, body: string): boolean =>
  status === 400 &&
  /response_format|json_schema|json mode|structured output/i.test(body);

/**
 * Reasoning models (Nemotron, DeepSeek-R1, QwQ, ...) spend seconds — sometimes
 * minutes — emitting invisible `reasoning` deltas before any content arrives,
 * which reads to the user as a hang. Ask for it off; hosts that do not know
 * the field ignore it. A stubbornly reasoning model is still handled by the
 * generous token budget below.
 */
const REASONING_OFF = { reasoning: { enabled: false } };

const postChatCompletions = async (
  provider: ProviderConfig,
  payload: Record<string, unknown>,
): Promise<Response> => {
  const send = (body: Record<string, unknown>) =>
    fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: openAiHeaders(provider),
      body: JSON.stringify(body),
    });

  const first = await send({ ...payload, ...REASONING_OFF });

  if (!first.ok) {
    return first;
  }

  /*
   * Only a *rejected* response_format justifies a retry without it. The body
   * must not be read here: on the streaming path this is the live stream, and
   * consuming it to sniff for an error string would stall the whole reply —
   * which showed up as the client waiting forever on zero bytes.
   */
  const { response_format: _dropped, ...rest } = payload;
  void _dropped;
  if (!rejectedResponseFormat(first.status, "")) {
    return first;
  }

  return send({ ...rest, ...REASONING_OFF });
};

const openAiError = async (response: Response): Promise<Error> => {
  let detail = "";
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
    };
    detail =
      typeof body.error === "string"
        ? body.error
        : (body.error?.message ?? "");
  } catch {
    // A non-JSON error body still leaves us the status code.
  }

  return new Error(
    detail || `The model provider returned status ${response.status}.`,
  );
};

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** One-shot: send the conversation, get the complete reply text. */
export const completeDrawing = async (
  provider: ProviderConfig,
  call: ModelCall,
  options: ModelOptions,
): Promise<string> => {
  if (provider.id === "gemini") {
    const response = await geminiChat(provider, call, options).sendMessage({
      message: geminiContent(call),
    });

    const blocked = response.promptFeedback?.blockReason;
    if (blocked) {
      throw new Error(`The request was blocked (${blocked}).`);
    }

    return response.text ?? "";
  }

  const response = await postChatCompletions(provider, {
    model: provider.model,
    temperature: options.temperature ?? 0.2,
    // Generous because a model that reasons anyway spends much of the budget
    // on invisible thinking tokens; running out mid-JSON would truncate the
    // reply into something unparseable.
    max_tokens: (options.maxOutputTokens ?? 8192) * 2,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "drawing_intent",
        strict: false,
        schema: toJsonSchema(options.schema),
      },
    },
    messages: openAiMessages(call),
  });

  if (!response.ok) {
    throw await openAiError(response);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };

  return body.choices?.[0]?.message?.content ?? "";
};

/**
 * Streaming: the reply's JSON text arrives piece by piece over a plain byte
 * stream — exactly the shape the client's incremental parser already consumes
 * for Gemini, so the wire format does not change per provider.
 */
export const streamDrawing = async (
  provider: ProviderConfig,
  call: ModelCall,
  options: ModelOptions,
): Promise<ReadableStream<Uint8Array>> => {
  if (provider.id === "gemini") {
    const chunks = await geminiChat(provider, call, options).sendMessageStream({
      message: geminiContent(call),
    });

    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of chunks) {
            const piece = chunk.text;
            if (piece) {
              controller.enqueue(encoder.encode(piece));
            }
          }
        } catch {
          // A mid-stream failure simply ends the body early; the client's
          // parse of what arrived surfaces the error.
        } finally {
          controller.close();
        }
      },
    });
  }

  const response = await postChatCompletions(provider, {
    model: provider.model,
    temperature: options.temperature ?? 0.2,
    // Same reasoning-token headroom as the non-streaming path.
    max_tokens: (options.maxOutputTokens ?? 8192) * 2,
    stream: true,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "drawing_intent",
        strict: false,
        schema: toJsonSchema(options.schema),
      },
    },
    messages: openAiMessages(call),
  });

  if (!response.ok || !response.body) {
    throw await openAiError(response);
  }

  // The upstream body is SSE ("data: {...}" lines); flatten it to the raw
  // text deltas the client expects.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let pending = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          // The last element is either "" (chunk ended on a newline) or a partial
          // line; either way it waits for the next read.
          pending = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) {
              continue;
            }

            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") {
              continue;
            }

            try {
              const chunk = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string | null } }>;
              };
              const piece = chunk.choices?.[0]?.delta?.content;
              if (piece) {
                controller.enqueue(encoder.encode(piece));
              }
            } catch {
              // A malformed complete line is skipped.
            }
          }
        }
      } catch {
        // Stream aborted or network broken
      } finally {
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
};
