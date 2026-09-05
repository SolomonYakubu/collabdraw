// @vitest-environment jsdom
/**
 * The AI assistant: one request, a reply that arrives in pieces, and a canvas
 * that must never be left half-drawn.
 *
 * Two things make this hook awkward, and both have their own failures. The first
 * is that a scene renders *while* it streams and is then reconciled against the
 * authoritative full-text parse — so every early return has to put the canvas
 * back (`restoreBase`) or the user keeps a preview the model never confirmed.
 * The second is that the assistant writes to the same canvas it watches: without
 * the `aiWriting` grace period its own elements read as a user edit, and the
 * automatic turn feeds itself forever.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_WRITE_SETTLE_MS,
  AUTO_RESPOND_DELAY_MS,
  useAIAssistant,
  type AIChatEntry,
} from "../useAIAssistant";
import { createElement } from "../../../services/canvas/elements";
import { MAX_SCENE_ITEMS } from "../../../services/ai/scene";
import { DEFAULT_STYLE } from "../../../types/shapes";
import type { BoundingBox, Shape } from "../../../types/shapes";
import type { ApplyOptions, ElementsUpdater } from "../useScene";

const exportSceneToDataURL = vi.hoisted(() => vi.fn(() => "data:image/jpeg;base64,snap"));

vi.mock("../../../services/canvas/renderer", () => ({ exportSceneToDataURL }));

const STORAGE_KEY = "collabdraw_ai_history:local";

/** One request the hook made, as the endpoint would read it. */
interface Call {
  body: Record<string, unknown>;
}

let calls: Call[];
let replies: Array<() => Response>;

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

/** A streamed reply, split so items complete one chunk at a time. */
const streamOf = (text: string, chunkSize = 24) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (let i = 0; i < text.length; i += chunkSize) {
          controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );

const sceneItem = (text: string, x: number, attrs: Record<string, unknown> = {}) => ({
  shape: "rectangle",
  x,
  y: 10,
  width: 18,
  height: 12,
  text,
  ...attrs,
});

const reply = (extra: Record<string, unknown>) =>
  JSON.stringify({
    title: "A title",
    summary: "A summary",
    placement: "add",
    action: "draw",
    ...extra,
  });

const sceneReply = (
  items: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => reply({ kind: "scene", scene: { items }, ...extra });

const gridReply = (extra: Record<string, unknown> = {}) =>
  reply({
    kind: "grid",
    grid: {
      rows: 2,
      columns: 2,
      cells: [
        { row: 0, column: 0, text: "one" },
        { row: 0, column: 1, text: "two" },
        { row: 1, column: 0, text: "three" },
        { row: 1, column: 1, text: "four" },
      ],
    },
    ...extra,
  });

const freehand = (): Shape =>
  createElement("Freehand", { id: "sketch", points: [0, 0, 10, 10, 20, 5] })!;

const box = (id: string): Shape =>
  createElement("Square", { id, x: 0, y: 0, width: 100, height: 100 })!;

/** The scene refs, apply recorder and viewport the hook is handed. */
const makeHarness = (initial: readonly Shape[] = [], roomId: string | null = null) => {
  const harness = {
    elementsRef: { current: [...initial] as Shape[] },
    applied: [] as Array<{ options: ApplyOptions; result: Shape[] }>,
    commits: 0,
    placed: [] as BoundingBox[],
    roomId,
    center: { x: 0, y: 0 },

    applyElements(updater: ElementsUpdater, options: ApplyOptions = {}): Shape[] {
      const next =
        typeof updater === "function" ? updater(harness.elementsRef.current) : updater;
      harness.elementsRef.current = next;
      harness.applied.push({ options, result: next });
      return next;
    },

    commit(): void {
      harness.commits += 1;
    },

    getViewportCenter: () => harness.center,
    onDiagramPlaced: (bounds: BoundingBox) => harness.placed.push(bounds),

    get lastApplied() {
      return harness.applied[harness.applied.length - 1];
    },
  };

  return harness;
};

type Harness = ReturnType<typeof makeHarness>;

const setup = (harness: Harness) =>
  renderHook(
    ({ roomId }: { roomId: string | null }) =>
      useAIAssistant({
        elementsRef: harness.elementsRef,
        applyElements: harness.applyElements,
        commit: harness.commit,
        style: DEFAULT_STYLE,
        roomId,
        getViewportCenter: harness.getViewportCenter,
        onDiagramPlaced: harness.onDiagramPlaced,
      }),
    { initialProps: { roomId: harness.roomId } },
  );

beforeEach(() => {
  calls = [];
  replies = [];
  window.localStorage.clear();
  exportSceneToDataURL.mockClear();
  exportSceneToDataURL.mockReturnValue("data:image/jpeg;base64,snap");

  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = replies.shift();
    if (!next) {
      throw new Error("no reply queued for this request");
    }
    return Promise.resolve(next());
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Runs a turn to completion, including the batched reveal's own timers. */
const generate = async (
  result: { current: ReturnType<typeof useAIAssistant> },
  options?: { prompt?: string; hidden?: boolean },
) => {
  await act(async () => {
    await result.current.generate(options);
  });
};

describe("the transcript", () => {
  it("starts from what the room had last time", () => {
    const saved: AIChatEntry[] = [
      { role: "user", parts: [{ text: "draw a flowchart" }] },
      { role: "model", parts: [{ text: "Done." }] },
    ];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    const { result } = setup(makeHarness());

    expect(result.current.history).toEqual(saved);
  });

  it("keeps each room's transcript apart", () => {
    // Two boards open in two tabs must not talk into each other's conversation.
    window.localStorage.setItem(
      "collabdraw_ai_history:room-a",
      JSON.stringify([{ role: "user", parts: [{ text: "in room a" }] }]),
    );
    const harness = makeHarness([], "room-a");

    const { result } = setup(harness);

    expect(result.current.history[0].parts[0].text).toBe("in room a");
  });

  it("swaps transcripts when the board changes under it", () => {
    window.localStorage.setItem(
      "collabdraw_ai_history:room-b",
      JSON.stringify([{ role: "user", parts: [{ text: "in room b" }] }]),
    );
    const { result, rerender } = setup(makeHarness([], "room-a"));

    act(() => rerender({ roomId: "room-b" }));

    expect(result.current.history[0].parts[0].text).toBe("in room b");
    expect(result.current.prompt).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("drops entries that are not shaped like chat", () => {
    // The key is user-writable; a hand-edited or half-written value must not put
    // malformed turns into the next request body.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { role: "user", parts: [{ text: "keep me" }] },
        { role: "narrator", parts: [{ text: "wrong role" }] },
        { role: "model", parts: "not an array" },
        { role: "model", parts: [{ text: 7 }] },
        null,
        "a string",
      ]),
    );

    const { result } = setup(makeHarness());

    expect(result.current.history).toEqual([
      { role: "user", parts: [{ text: "keep me" }] },
    ]);
  });

  it("clears a corrupt entry rather than failing to load", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");

    const { result } = setup(makeHarness());

    expect(result.current.history).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("ignores a value that is valid JSON but not a list", () => {
    window.localStorage.setItem(STORAGE_KEY, '{"role":"user"}');

    const { result } = setup(makeHarness());

    expect(result.current.history).toEqual([]);
  });

  it("saves the turn so a reload keeps the conversation", async () => {
    const { result } = setup(makeHarness());
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "draw one box" });

    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(saved).toEqual([
      { role: "user", parts: [{ text: "draw one box" }], hidden: false },
      { role: "model", parts: [{ text: "A summary" }] },
    ]);
  });

  it("forgets the conversation, and its stored copy, on reset", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ role: "user", parts: [{ text: "old" }] }]),
    );
    const { result } = setup(makeHarness());

    act(() => result.current.resetConversation());

    expect(result.current.history).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("carries on when storage refuses to co-operate", () => {
    /*
     * Safari in private mode throws on read *and* on write, including the
     * remove that the read's own error handler tries. The transcript is a
     * convenience — losing it must not take the assistant down with it.
     *
     * Spied on the prototype: jsdom's `localStorage` is a proxy, and a spy
     * installed on the instance is never consulted.
     */
    const read = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("SecurityError");
      });
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });
    const remove = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });

    const { result } = setup(makeHarness());
    expect(result.current.history).toEqual([]);
    expect(read).toHaveBeenCalled();

    act(() => result.current.resetConversation());
    expect(result.current.error).toBeNull();

    read.mockRestore();
    write.mockRestore();
    remove.mockRestore();
  });
});

describe("the request", () => {
  it("sends the prompt, the scene as structure, and the transcript", async () => {
    const harness = makeHarness([box("existing")]);
    const { result } = setup(harness);
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "  draw a box  " });

    const body = calls[0].body;
    // Trimmed, so a stray space cannot look like a different prompt.
    expect(body.prompt).toBe("draw a box");
    expect(body.stream).toBe(true);
    // Structure, not pixels: the canvas goes out as a described summary.
    expect((body.scene as { items: Array<{ shape: string }> }).items).toEqual([
      expect.objectContaining({ shape: "rectangle", width: 100, height: 100 }),
    ]);
    expect(body.history).toEqual([
      { role: "user", parts: [{ text: "draw a box" }], hidden: false },
    ]);
  });

  it("sends the typed prompt when no override is given, and clears it after", async () => {
    const { result } = setup(makeHarness());
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    act(() => result.current.setPrompt("typed into the box"));
    await generate(result);

    expect(calls[0].body.prompt).toBe("typed into the box");
    expect(result.current.prompt).toBe("");
  });

  it("says nothing at all when there is nothing to say", async () => {
    const { result } = setup(makeHarness());

    await generate(result, { prompt: "   " });
    await generate(result);

    expect(calls).toEqual([]);
  });

  it("hides an automatic turn's prompt from the transcript", async () => {
    // It is still sent — the model needs to know what it was asked — but five
    // "your turn" bubbles the user never typed is noise.
    const { result } = setup(makeHarness());
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "the user has paused", hidden: true });

    expect(result.current.history[0]).toMatchObject({ hidden: true });
    expect((calls[0].body.history as AIChatEntry[])[0].hidden).toBe(true);
  });

  it("sends no picture when words cover the canvas", async () => {
    // The structured description already carries shapes, text and layout, so an
    // image of them is spend with nothing to show for it.
    const { result } = setup(makeHarness([box("plain")]));
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "add a box" });

    expect(calls[0].body.image).toBeNull();
    expect(exportSceneToDataURL).not.toHaveBeenCalled();
  });

  it("sends a picture once there is freehand on the canvas", async () => {
    // "freehand at (0,86) size 17x14" tells the model nothing about what was
    // drawn; this is the one case a description cannot replace.
    const { result } = setup(makeHarness([freehand()]));
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "what did I draw?" });

    expect(calls[0].body.image).toBe("data:image/jpeg;base64,snap");
    expect(exportSceneToDataURL).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: "jpeg", maxDimension: 896 }),
    );
  });

  it("ignores a deleted stroke when deciding to send a picture", async () => {
    const erased = { ...freehand(), isDeleted: true } as Shape;
    const { result } = setup(makeHarness([erased]));
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "anything there?" });

    expect(calls[0].body.image).toBeNull();
  });

  it("still asks when the snapshot cannot be rendered", async () => {
    // A canvas that fails to export must not take the whole request down with it.
    exportSceneToDataURL.mockImplementation(() => {
      throw new Error("canvas is too large");
    });
    const { result } = setup(makeHarness([freehand()]));
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "what did I draw?" });

    expect(calls[0].body.image).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("sends no kind hint, the endpoint classifying the request itself", async () => {
    // There was an Architecture toggle that put `mode: "system"` in the body.
    // The endpoint still accepts the field, but nothing in the client sets it —
    // its classifier already picks the system kind for a request like this one,
    // and a mode the user had to remember to flip was a second answer to the
    // same question.
    const { result } = setup(makeHarness());
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "design a queue" });

    expect(calls[0].body.mode).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it("refuses to start a second turn while one is in flight", async () => {
    const harness = makeHarness();
    const { result } = setup(harness);
    let release: (() => void) | null = null;
    replies = [
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              release = () => {
                controller.enqueue(
                  new TextEncoder().encode(sceneReply([sceneItem("One", 10)])),
                );
                controller.close();
              };
            },
          }),
          { status: 200 },
        ),
    ];

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.generate({ prompt: "first" });
      await Promise.resolve();
    });
    expect(result.current.isGenerating).toBe(true);

    // No reply is queued for a second request, so the fake would throw if it ran.
    await generate(result, { prompt: "second" });
    expect(calls).toHaveLength(1);

    await act(async () => {
      release?.();
      await first;
    });
    expect(result.current.isGenerating).toBe(false);
  });
});

describe("a reply that fails", () => {
  it("shows the endpoint's own message", async () => {
    const { result } = setup(makeHarness());
    replies = [() => jsonResponse({ error: "Daily limit reached." }, 429)];

    await generate(result, { prompt: "draw a box" });

    expect(result.current.error).toBe("Daily limit reached.");
    expect(result.current.isGenerating).toBe(false);
  });

  it("falls back to the status when the body is not the error shape", async () => {
    // A proxy or gateway failure returns HTML; the user still needs to be told.
    const { result } = setup(makeHarness());
    replies = [() => new Response("<html>502</html>", { status: 500 })];

    await generate(result, { prompt: "draw a box" });

    expect(result.current.error).toBe("Request failed with status 500");
  });

  it("reports a response with no body at all", async () => {
    const { result } = setup(makeHarness());
    replies = [() => new Response(null, { status: 200 })];

    await generate(result, { prompt: "draw a box" });

    expect(result.current.error).toBe(
      "The assistant returned an empty response.",
    );
  });

  it("reports a reply that is not the agreed shape", async () => {
    const harness = makeHarness();
    const { result } = setup(harness);
    replies = [() => streamOf("I would rather not, thanks.")];

    await generate(result, { prompt: "draw a box" });

    expect(result.current.error).toBe("The assistant returned nothing drawable.");
    expect(harness.elementsRef.current).toEqual([]);
  });

  it("puts the canvas back when the reply breaks off mid-stream", async () => {
    /*
     * The preview is drawn from completed items, so a truncated reply leaves
     * shapes on the canvas that the authoritative parse never confirmed. Without
     * the rollback the user keeps half a diagram and an error message.
     */
    const harness = makeHarness([box("mine")]);
    const base = harness.elementsRef.current;
    const { result } = setup(harness);
    // Every item has arrived; the closing brace of the envelope has not.
    replies = [
      () =>
        streamOf(
          sceneReply([sceneItem("One", 10), sceneItem("Two", 40)]).slice(0, -1),
        ),
    ];

    await generate(result, { prompt: "draw two boxes" });

    expect(result.current.error).toBe("The assistant returned nothing drawable.");
    // Restored by identity, so peers are told the scene is exactly as it was.
    expect(harness.elementsRef.current).toBe(base);
    expect(harness.lastApplied.options).toMatchObject({
      commit: false,
      broadcast: "full",
    });
    expect(harness.commits).toBe(0);
  });

  it("clears the message when the panel is dismissed", async () => {
    const { result } = setup(makeHarness());
    replies = [() => jsonResponse({ error: "Daily limit reached." }, 429)];
    await generate(result, { prompt: "draw a box" });

    act(() => result.current.dismissError());

    expect(result.current.error).toBeNull();
  });

  it("says nothing when the request was aborted", async () => {
    // An abort is the hook's own doing — unmount, or a newer turn — so there is
    // nobody to apologise to.
    const { result } = setup(makeHarness());
    replies = [
      () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      },
    ];

    await generate(result, { prompt: "draw a box" });

    expect(result.current.error).toBeNull();
  });
});

describe("a scene that streams", () => {
  it("draws each item as it arrives and commits the lot once", async () => {
    /*
     * The whole point of streaming: the first shape is on the canvas before the
     * model has finished writing. Each item lands uncommitted, and the confirmed
     * reply turns the preview into exactly one undo step — three separate steps
     * would take three presses to take back one drawing.
     */
    const harness = makeHarness();
    const { result } = setup(harness);
    replies = [
      () =>
        streamOf(
          sceneReply([
            sceneItem("One", 10),
            sceneItem("Two", 40),
            sceneItem("Three", 70),
          ]),
        ),
    ];

    await generate(result, { prompt: "three boxes" });

    expect(harness.applied).toHaveLength(3);
    expect(harness.applied.every(({ options }) => options.commit === false)).toBe(
      true,
    );
    expect(harness.commits).toBe(1);
    // A labelled rectangle is a container plus its bound text.
    expect(harness.elementsRef.current).toHaveLength(6);
    expect(harness.placed).toHaveLength(1);
    expect(result.current.history[1]).toEqual({
      role: "model",
      parts: [{ text: "A summary" }],
    });
    expect(result.current.prompt).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("names the elements it added, so peers get only those", async () => {
    const harness = makeHarness();
    const { result } = setup(harness);
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "one box" });

    const { options } = harness.applied[0];
    expect(options.changedIds).toEqual(
      harness.elementsRef.current.map((element) => element.id),
    );
  });

  it("clears the canvas on the first item when the reply replaces it", async () => {
    // The clearing write is positional — a peer that only heard about the new
    // elements would still be showing everything they replaced.
    const harness = makeHarness([box("old")]);
    const { result } = setup(harness);
    replies = [
      () =>
        streamOf(
          sceneReply([sceneItem("One", 10), sceneItem("Two", 40)], {
            placement: "replace",
          }),
        ),
    ];

    await generate(result, { prompt: "start again" });

    expect(harness.elementsRef.current.some(({ id }) => id === "old")).toBe(false);
    expect(harness.applied[0].options).toMatchObject({
      commit: false,
      broadcast: "full",
    });
    // Only the first write clears; the rest are ordinary appends.
    expect(harness.applied[1].options.broadcast).toBe("elements");
  });

  it("keeps what was there and lines the new work up with it", async () => {
    /*
     * `add` anchors the scene's normalised coordinates to the box the canvas
     * already occupies — the model was shown that layout, so its 0-100 positions
     * only mean anything against the same frame.
     */
    const harness = makeHarness([box("old")]);
    const { result } = setup(harness);
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "add a box" });

    expect(harness.elementsRef.current[0].id).toBe("old");
    const added = harness.elementsRef.current[1];
    expect(added.x).toBeGreaterThanOrEqual(0);
    expect(added.x).toBeLessThanOrEqual(100);
  });

  it("draws at the viewport centre on an empty canvas", async () => {
    // Nothing to anchor to, so it has to land where the user is looking rather
    // than at the world origin they may have scrolled far away from.
    const harness = makeHarness();
    harness.center = { x: 4000, y: 2000 };
    const { result } = setup(harness);
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];

    await generate(result, { prompt: "one box" });

    const bounds = harness.placed[0];
    expect(bounds.x).toBeGreaterThan(3600);
    expect(bounds.x).toBeLessThan(4400);
    expect(bounds.y).toBeGreaterThan(1600);
    expect(bounds.y).toBeLessThan(2400);
  });

  it("stops at the same ceiling the whole reply is parsed under", async () => {
    /*
     * The preview is only kept because the streamed items and the confirmed ones
     * are the same set. Two different ceilings would leave shapes on the canvas
     * that the authoritative parse dropped, committed as if they were confirmed.
     */
    const harness = makeHarness();
    const { result } = setup(harness);
    const many = Array.from({ length: MAX_SCENE_ITEMS + 5 }, (_, index) =>
      sceneItem(`n${index}`, (index % 8) * 10),
    );
    replies = [() => streamOf(sceneReply(many))];

    await generate(result, { prompt: "far too many boxes" });

    expect(harness.applied).toHaveLength(MAX_SCENE_ITEMS);
    expect(harness.commits).toBe(1);
    expect(result.current.error).toBeNull();
  });
});

describe("a reply that arrives whole", () => {
  it("reveals a grid in batches and commits on the last", async () => {
    /*
     * A grid's cell size depends on the widest cell anywhere in it, so it cannot
     * be drawn one cell at a time — later cells would resize the ones already on
     * screen. It is built whole and revealed in order instead, and the reveal is
     * one undo step: only the closing write commits.
     */
    const harness = makeHarness();
    const { result } = setup(harness);
    replies = [() => streamOf(gridReply())];

    await generate(result, { prompt: "a two by two table" });

    expect(harness.applied.length).toBeGreaterThan(1);
    expect(
      harness.applied.slice(0, -1).every(({ options }) => options.commit === false),
    ).toBe(true);
    expect(harness.lastApplied.options.commit).toBe(true);
    // The reveal commits through `applyElements`, so nothing calls `commit()`.
    expect(harness.commits).toBe(0);
    expect(harness.placed).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("sends the whole scene to peers when a grid replaces the canvas", async () => {
    const harness = makeHarness([box("old")]);
    const { result } = setup(harness);
    replies = [() => streamOf(gridReply({ placement: "replace" }))];

    await generate(result, { prompt: "replace this with a table" });

    expect(harness.elementsRef.current.some(({ id }) => id === "old")).toBe(false);
    expect(harness.applied[0].options.broadcast).toBe("full");
    expect(harness.applied[1].options.broadcast).toBe("elements");
  });

  it("reveals a scene the stream never got to preview", async () => {
    // `kind` is a hint, and an older reply can leave it out — the payload still
    // draws, just without the progressive preview.
    const harness = makeHarness();
    const { result } = setup(harness);
    replies = [
      () =>
        streamOf(
          reply({
            scene: {
              items: [sceneItem("One", 10), sceneItem("Two", 40), sceneItem("Three", 70)],
            },
          }),
        ),
    ];

    await generate(result, { prompt: "three boxes" });

    expect(harness.elementsRef.current).toHaveLength(6);
    expect(harness.applied).toHaveLength(3);
    expect(harness.lastApplied.options.commit).toBe(true);
    expect(harness.commits).toBe(0);
  });

  it("undoes the preview before revealing a build that disagrees with it", async () => {
    /*
     * The preview is only kept when the streamed items and the confirmed reply
     * are the same set. Here the model declared a scene and then sent a grid, so
     * the canvas has to go back to the user's own work before the grid arrives —
     * otherwise the two builds are drawn on top of each other.
     */
    const harness = makeHarness([box("mine")]);
    const { result } = setup(harness);
    replies = [
      () =>
        streamOf(
          gridReply({
            kind: "scene",
            scene: { items: [{ shape: "blob", x: 1, y: 1, width: 5, height: 5 }] },
          }),
        ),
    ];

    await generate(result, { prompt: "a table" });

    // The rollback goes first, and tells peers the scene entire.
    expect(harness.applied[0].options).toMatchObject({
      commit: false,
      broadcast: "full",
    });
    expect(harness.elementsRef.current[0].id).toBe("mine");
    expect(harness.elementsRef.current.length).toBeGreaterThan(1);
    expect(harness.lastApplied.options.commit).toBe(true);
    expect(result.current.error).toBeNull();
  });
});

describe("a reply that declines to draw", () => {
  it("rolls the preview back and keeps only what it said", async () => {
    /*
     * The automatic turn asks the model on every pause, and it used to draw
     * something every time — over work the user was still arranging. A `wait`
     * leaves the canvas exactly as the user left it.
     */
    const harness = makeHarness([box("mine")]);
    const base = harness.elementsRef.current;
    const { result } = setup(harness);
    replies = [
      () =>
        streamOf(
          sceneReply([sceneItem("One", 10)], {
            action: "wait",
            summary: "Carry on — I will stay out of the way.",
          }),
        ),
    ];

    await generate(result, { prompt: "the user has paused" });

    expect(harness.elementsRef.current).toBe(base);
    expect(harness.commits).toBe(0);
    expect(harness.placed).toEqual([]);
    expect(result.current.history[1].parts[0].text).toBe(
      "Carry on — I will stay out of the way.",
    );
    expect(result.current.error).toBeNull();
  });

  it("still shows a turn when it declines without a word", async () => {
    // The transcript is what stops the auto-responder starting from scratch, so
    // an empty model turn must still be recorded.
    const { result } = setup(makeHarness());
    replies = [
      () =>
        streamOf(
          sceneReply([sceneItem("One", 10)], {
            action: "wait",
            title: "",
            summary: "",
          }),
        ),
    ];

    await generate(result, { prompt: "the user has paused" });

    expect(result.current.history[1].parts[0].text).toBe("(waiting)");
  });

  it("falls back to a word of its own when it draws without one", async () => {
    const { result } = setup(makeHarness());
    replies = [
      () => streamOf(sceneReply([sceneItem("One", 10)], { title: "", summary: "" })),
    ];

    await generate(result, { prompt: "one box" });

    expect(result.current.history[1].parts[0].text).toBe("Done.");
  });
});

describe("answering the user's own edits", () => {
  /** Advances the frozen clock, letting each turn it starts run to completion. */
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  /**
   * A first turn, so a conversation exists — and then past the grace period, so
   * the assistant's own elements have stopped counting as the user's. Live goes
   * on as well, since it starts off and everything below is about what happens
   * once it is on; the two tests about it being off pass `live: false`.
   */
  const seed = async (
    result: { current: ReturnType<typeof useAIAssistant> },
    { live = true }: { live?: boolean } = {},
  ) => {
    replies = [() => streamOf(sceneReply([sceneItem("One", 10)]))];
    await generate(result, { prompt: "draw one box" });
    await advance(AI_WRITE_SETTLE_MS);
    if (live) {
      act(() => result.current.setAutoRespond(true));
    }
    replies = [
      () =>
        streamOf(
          sceneReply([sceneItem("Two", 40)], { summary: "Added a second box." }),
        ),
    ];
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("waits for the canvas to go still, then asks in the user's name", async () => {
    const { result } = setup(makeHarness());
    await seed(result);

    act(() => result.current.notifyUserEdit());
    await advance(AUTO_RESPOND_DELAY_MS - 1);
    // Still drawing as far as the hook knows.
    expect(calls).toHaveLength(1);

    await advance(1);

    expect(calls).toHaveLength(2);
    expect(String(calls[1].body.prompt)).toContain("The user has paused");
    const sent = calls[1].body.history as AIChatEntry[];
    expect(sent[sent.length - 1].hidden).toBe(true);
  });

  it("treats a flurry of edits as one pause", async () => {
    // Every element change calls in; without the debounce a two-minute drawing
    // session would queue a request per stroke.
    const { result } = setup(makeHarness());
    await seed(result);

    act(() => result.current.notifyUserEdit());
    await advance(2000);
    act(() => result.current.notifyUserEdit());
    await advance(2000);
    expect(calls).toHaveLength(1);

    await advance(1000);
    expect(calls).toHaveLength(2);
  });

  it("stays quiet until the user has spoken once", async () => {
    // Nobody has asked the assistant anything yet; drawing on a blank board
    // unprompted is not its business. Live is on, so the empty history is the
    // only thing holding the turn back.
    const { result } = setup(makeHarness());
    act(() => result.current.setAutoRespond(true));

    act(() => result.current.notifyUserEdit());
    await advance(AUTO_RESPOND_DELAY_MS * 2);

    expect(calls).toEqual([]);
  });

  it("is off until it is switched on", async () => {
    /*
     * An automatic turn is a request nobody typed: it spends the deployment's API
     * quota and can redraw the canvas while the user is still reading it. It used
     * to start on, so a first prompt and a pause were enough to get one.
     */
    const { result } = setup(makeHarness());
    await seed(result, { live: false });

    act(() => result.current.notifyUserEdit());
    await advance(AUTO_RESPOND_DELAY_MS * 2);

    expect(result.current.autoRespond).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("goes quiet again when the toggle is turned back off", async () => {
    const { result } = setup(makeHarness());
    await seed(result);
    act(() => result.current.setAutoRespond(false));

    act(() => result.current.notifyUserEdit());
    await advance(AUTO_RESPOND_DELAY_MS * 2);

    expect(result.current.autoRespond).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("does not read its own drawing as an edit", async () => {
    /*
     * The assistant writes to the canvas it is watching. Inside the grace period
     * its own elements arrive as element changes like any other, and answering
     * them makes it draw, notice its drawing, and draw again, forever.
     */
    const { result } = setup(makeHarness());
    await seed(result);
    replies = [() => streamOf(sceneReply([sceneItem("Two", 40)]))];
    await generate(result, { prompt: "add another" });

    act(() => result.current.notifyUserEdit());
    await advance(AUTO_RESPOND_DELAY_MS * 2);

    expect(calls).toHaveLength(2);
  });

  it("drops a pause that its own drawing lands on top of", async () => {
    // Scheduled while the canvas was the user's, fired after the assistant had
    // just written — the inner check is what the grace period cannot catch.
    const { result } = setup(makeHarness());
    await seed(result);

    act(() => result.current.notifyUserEdit());
    await advance(AUTO_RESPOND_DELAY_MS - 200);
    await generate(result, { prompt: "add another" });
    await advance(200);

    expect(calls).toHaveLength(2);
  });

  it("forgets a pending pause when the canvas closes", async () => {
    // The timer outlives the component; left running it calls a hook that has
    // already torn down its abort controller.
    const { result, unmount } = setup(makeHarness());
    await seed(result);
    act(() => result.current.notifyUserEdit());

    unmount();
    await advance(AUTO_RESPOND_DELAY_MS * 2);

    expect(calls).toHaveLength(1);
  });
});

describe("a canvas that closes mid-turn", () => {
  /** Lets the pending fetch, reads and timers get as far as they can. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("stops reading the stream and leaves the scene alone", async () => {
    /*
     * The reply keeps arriving after the board is closed or navigated away from.
     * Every write from here lands on a scene nobody is looking at, and is
     * broadcast to peers as if the user had drawn it.
     */
    const harness = makeHarness();
    const { result, unmount } = setup(harness);
    const full = sceneReply([sceneItem("One", 10), sceneItem("Two", 40)]);
    const cut = full.indexOf('{"shape":"rectangle","x":40');
    let push: ((text: string) => void) | null = null;
    let finish: (() => void) | null = null;
    replies = [
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              push = (text) => controller.enqueue(encoder.encode(text));
              finish = () => controller.close();
            },
          }),
          { status: 200 },
        ),
    ];

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.generate({ prompt: "two boxes" });
      await settle();
    });
    await act(async () => {
      push?.(full.slice(0, cut));
      await settle();
    });
    const drawn = harness.applied.length;
    expect(drawn).toBeGreaterThan(0);

    unmount();
    await act(async () => {
      push?.(full.slice(cut));
      finish?.();
      await pending;
    });

    expect(harness.applied).toHaveLength(drawn);
    expect(harness.commits).toBe(0);
    expect(harness.placed).toEqual([]);
  });

  it("stops a reveal that is still part-way through", async () => {
    // The batched reveal waits between batches, which is exactly where an
    // unmount lands: the rest of the grid must not be written.
    const harness = makeHarness();
    const { result, unmount } = setup(harness);
    replies = [() => streamOf(gridReply())];

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.generate({ prompt: "a table" });
      await settle();
    });
    const drawn = harness.applied.length;
    expect(drawn).toBeGreaterThan(0);
    expect(harness.lastApplied.options.commit).toBe(false);

    unmount();
    await act(async () => {
      await pending;
    });

    expect(harness.applied).toHaveLength(drawn);
    expect(harness.placed).toEqual([]);
  });
});
