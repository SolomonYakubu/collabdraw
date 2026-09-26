// @vitest-environment jsdom
/**
 * Copying to the clipboard.
 *
 * `navigator.clipboard.writeText` can refuse a copy for reasons the click does
 * not control: the document is not focused yet (the state the first click on a
 * freshly loaded page finds), the permission has not been granted, or the origin
 * is plain HTTP. The classic symptom is a copy button that needs two presses —
 * the first click focuses the window, the second succeeds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyText } from "../clipboard";

const LINK = "https://collabdraw.example/board/abc123";

/** Swap the browser's clipboard, as the real API may or may not be present. */
const provideClipboard = (writeText: (text: string) => Promise<void>) => {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
};

const stubExecCommand = (result: boolean) => {
  const doc = document as unknown as Record<string, unknown>;
  doc.execCommand = vi.fn(() => result);
};

let originalExecCommand: Document["execCommand"];

beforeEach(() => {
  originalExecCommand = document.execCommand;
});

afterEach(() => {
  document.execCommand = originalExecCommand;
  vi.restoreAllMocks();
  document.body.textContent = "";
});

describe("copyText", () => {
  it("writes through the async clipboard, focusing the document first", async () => {
    const order: string[] = [];
    vi.spyOn(window, "focus").mockImplementation(() => order.push("focus"));
    provideClipboard(async () => {
      order.push("write");
    });

    expect(await copyText(LINK)).toBe(true);
    // Focus before the write: an unfocused document is what refuses the copy.
    expect(order).toEqual(["focus", "write"]);
  });

  it("uses the selection fallback when the Clipboard API refuses", async () => {
    provideClipboard(() => Promise.reject(new Error("NotAllowedError")));
    stubExecCommand(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await copyText(LINK)).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    // The refusal is said, not kept quiet — and then worked around.
    expect(warn).toHaveBeenCalledTimes(1);

    // The temporary textarea is gone from the document afterwards.
    expect(document.body.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("says so when neither path can write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    provideClipboard(() => Promise.reject(new Error("NotAllowedError")));
    stubExecCommand(false);

    expect(await copyText(LINK)).toBe(false);
    // The API's refusal is warned about; the fallback simply reporting false
    // through `execCommand` is not an error, so there is no second warning.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("copies from the fallback alone when there is no Clipboard API", async () => {
    // Plain-HTTP origins and older browsers offer no navigator.clipboard at
    // all; the selection path is the only one.
    Object.defineProperty(window, "navigator", {
      configurable: true,
      value: {},
    });
    stubExecCommand(true);

    expect(await copyText(LINK)).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("returns false for nothing to write", async () => {
    expect(await copyText("")).toBe(false);
  });
});
