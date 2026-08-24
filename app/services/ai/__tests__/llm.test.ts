import { afterEach, describe, expect, it } from "vitest";
import { resolveProvider } from "../llm";

/** Save and clear the env vars the resolver reads, per test. */
const withEnv = (
  vars: Record<string, string | undefined>,
  run: () => void,
): void => {
  const keys = [
    "AI_API_KEY",
    "AI_PROVIDER",
    "AI_MODEL",
    "AI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
  ];
  const saved = new Map(
    keys.map((key) => [key, process.env[key]] as const),
  );

  try {
    for (const key of keys) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(vars)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    run();
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

describe("resolveProvider", () => {
  afterEach(() => {});

  it("returns null when no key is configured", () => {
    withEnv({}, () => {
      expect(resolveProvider()).toBeNull();
    });
  });

  it("detects gemini from its key", () => {
    withEnv({ GEMINI_API_KEY: "g-key" }, () => {
      const provider = resolveProvider();
      expect(provider?.id).toBe("gemini");
      expect(provider?.apiKey).toBe("g-key");
      expect(provider?.model).toMatch(/^gemini/);
    });
  });

  it("detects openai and openrouter from their keys", () => {
    withEnv({ OPENAI_API_KEY: "o-key" }, () => {
      expect(resolveProvider()?.id).toBe("openai");
    });

    withEnv({ OPENROUTER_API_KEY: "r-key" }, () => {
      const provider = resolveProvider();
      expect(provider?.id).toBe("openrouter");
      expect(provider?.baseUrl).toContain("openrouter.ai");
    });
  });

  it("prefers the first configured key when several are set", () => {
    withEnv(
      { GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", OPENROUTER_API_KEY: "r" },
      () => {
        // AI_API_KEY first, then OpenRouter, then OpenAI, then Gemini.
        expect(resolveProvider()?.id).toBe("openrouter");
      },
    );
  });

  it("lets AI_PROVIDER override detection", () => {
    withEnv(
      { GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", AI_PROVIDER: "openai" },
      () => {
        const provider = resolveProvider();
        expect(provider?.id).toBe("openai");
        expect(provider?.apiKey).toBe("o");
      },
    );
  });

  it("lets AI_MODEL pick any model on the chosen provider", () => {
    withEnv(
      { OPENROUTER_API_KEY: "r", AI_MODEL: "anthropic/claude-3.5-sonnet" },
      () => {
        expect(resolveProvider()?.model).toBe(
          "anthropic/claude-3.5-sonnet",
        );
      },
    );
  });

  it("requires a base URL for the custom provider", () => {
    withEnv({ AI_API_KEY: "k", AI_PROVIDER: "custom" }, () => {
      expect(resolveProvider()).toBeNull();
    });

    withEnv(
      {
        AI_API_KEY: "k",
        AI_PROVIDER: "custom",
        AI_BASE_URL: "http://localhost:11434/v1/",
      },
      () => {
        const provider = resolveProvider();
        expect(provider?.baseUrl).toBe("http://localhost:11434/v1");
      },
    );
  });

  it("ignores an unknown AI_PROVIDER and falls back to detection", () => {
    withEnv({ GEMINI_API_KEY: "g", AI_PROVIDER: "azure" }, () => {
      expect(resolveProvider()?.id).toBe("gemini");
    });
  });
});

/* ------------------------------------------------------------------ *
 * SSE flattening (the OpenAI-compatible streaming path)
 * ------------------------------------------------------------------ */

/**
 * The buffering loop inside `streamDrawing`, extracted so it can be tested
 * without a network. Keep in sync with the implementation.
 *
 * The bug this guards against: splitting each network chunk on "\n"
 * independently drops every delta whenever the provider splits one SSE line
 * across two chunks — which read to the user as an endless spinner.
 */
const flattenSse = async (chunks: string[]): Promise<string> => {
  let pending = "";
  let out = "";

  for (const value of chunks) {
    pending += value;
    const lines = pending.split("\n");
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
          out += piece;
        }
      } catch {
        // Malformed complete lines are skipped.
      }
    }
  }

  return out;
};

const sseLine = (content: string): string =>
  `${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null }],
  })}\n`;

describe("OpenAI-compatible SSE flattening", () => {
  it("reassembles content from well-formed chunks", async () => {
    const result = await flattenSse([
      `data: ${sseLine("{\n")}`,
      `data: ${sseLine('"kind"')}`,
      `data: ${sseLine(":1}")}`,
      "data: [DONE]\n",
    ]);

    expect(result).toBe('{\n"kind":1}');
  });

  it("survives an SSE line split across two network chunks", async () => {
    const full = `data: ${sseLine("hello")}`;
    const cut = Math.floor(full.length / 2);

    const result = await flattenSse([full.slice(0, cut), full.slice(cut)]);

    expect(result).toBe("hello");
  });

  it("drops nothing when every chunk boundary lands mid-line", async () => {
    const stream =
      `data: ${sseLine("one")}` +
      `data: ${sseLine("two")}` +
      `data: ${sseLine("three")}`;

    // One character at a time: worst possible chunking.
    const chars = stream.split("");

    expect(await flattenSse(chars)).toBe("onetwothree");
  });

  it("handles comment keep-alive lines between data lines", async () => {
    const result = await flattenSse([
      ": OPENROUTER PROCESSING\n\n",
      `data: ${sseLine("ok")}\n`,
      ": OPENROUTER PROCESSING\n\n",
      "data: [DONE]\n",
    ]);

    expect(result).toBe("ok");
  });
});
