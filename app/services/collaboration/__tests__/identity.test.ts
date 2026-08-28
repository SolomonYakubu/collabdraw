import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateUserName,
  MAX_USER_NAME_LENGTH,
  normalizeUserName,
  readUserId,
  readUserName,
  USER_ID_KEY,
  USER_NAME_KEY,
  writeUserName,
} from "../identity";

/**
 * Minimal in-memory `localStorage` — the suite runs in the `node` environment,
 * so there is no real one. `failOnWrite` stands in for private browsing or a
 * full quota, which identity has to survive rather than throw through.
 */
class MemoryStorage {
  private entries = new Map<string, string>();
  failOnWrite = false;

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnWrite) {
      throw new Error("blocked");
    }
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeUserName", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeUserName("  Ada   Lovelace \n")).toBe("Ada Lovelace");
  });

  it("clamps to the length the server accepts", () => {
    const name = normalizeUserName("x".repeat(MAX_USER_NAME_LENGTH + 20));
    expect(name).toHaveLength(MAX_USER_NAME_LENGTH);
  });

  it("returns empty for input with nothing usable in it", () => {
    expect(normalizeUserName("   \t \n ")).toBe("");
  });
});

describe("generateUserName", () => {
  it("produces a non-empty name within the length limit", () => {
    const name = generateUserName();
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(MAX_USER_NAME_LENGTH);
  });
});

describe("readUserName", () => {
  it("generates and persists a name on first use", () => {
    const first = readUserName();
    expect(first).not.toBe("");
    expect(storage.getItem(USER_NAME_KEY)).toBe(first);
  });

  it("returns the same name on the next read — the point of persisting it", () => {
    expect(readUserName()).toBe(readUserName());
  });

  it("prefers a stored name over a generated one", () => {
    storage.setItem(USER_NAME_KEY, "Ada");
    expect(readUserName()).toBe("Ada");
  });

  it("normalizes what it finds, so a padded entry reads back clean", () => {
    storage.setItem(USER_NAME_KEY, "  Ada   Lovelace  ");
    expect(readUserName()).toBe("Ada Lovelace");
  });

  it("falls back to a generated name when a stored one is unusable", () => {
    storage.setItem(USER_NAME_KEY, "   ");
    expect(readUserName()).not.toBe("");
  });

  it("still answers when storage refuses to be read", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem() {
          throw new Error("blocked");
        },
      },
    });
    expect(readUserName()).not.toBe("");
  });
});

describe("writeUserName", () => {
  it("stores the normalized name and hands it back", () => {
    expect(writeUserName("  Ada  Lovelace ")).toBe("Ada Lovelace");
    expect(readUserName()).toBe("Ada Lovelace");
  });

  it("refuses a blank name, so the previous one is kept", () => {
    writeUserName("Ada");
    expect(writeUserName("   ")).toBeNull();
    expect(readUserName()).toBe("Ada");
  });

  it("reports the name it accepted even when storage rejects the write", () => {
    storage.failOnWrite = true;
    // Blocked storage means the choice does not outlive the session, not that
    // the rename failed — the socket still gets told.
    expect(writeUserName("Ada")).toBe("Ada");
  });
});

describe("readUserId", () => {
  it("mints and persists an id on first use", () => {
    const id = readUserId();
    expect(id).not.toBe("");
    expect(storage.getItem(USER_ID_KEY)).toBe(id);
    expect(readUserId()).toBe(id);
  });

  it("is separate from the display name, so renaming does not change identity", () => {
    const id = readUserId();
    writeUserName("Ada");
    expect(readUserId()).toBe(id);
  });

  it("falls back to a per-session id when storage is unavailable", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem() {
          throw new Error("blocked");
        },
      },
    });
    expect(readUserId()).not.toBe("");
  });
});
