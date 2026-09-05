import { describe, expect, it } from "vitest";
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

/*
 * The transports themselves — the request that goes on the wire, the schema
 * translation and the SSE flattening — are covered in `llmTransport.test.ts`,
 * against the real `completeDrawing` and `streamDrawing`.
 */
