"use client";

/**
 * AI diagram assistant.
 *
 * The endpoint returns a graph; this turns it into elements. Layout, sizing and
 * connector routing all happen here, on the client, because this is where text
 * can actually be measured and where the same binding machinery that serves
 * hand-drawn arrows already lives. AI diagrams therefore behave like any other:
 * drag a node and its arrows follow.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoundingBox, ElementStyle, Shape } from "../../types/shapes";
import { getElementBounds } from "../../services/canvas/elements";
import { exportSceneToDataURL } from "../../services/canvas/renderer";
import { describeScene } from "../../services/ai/describeScene";
import {
  buildFromIntent,
  placeSceneItem,
  sceneFrame,
  type SceneFrame,
} from "../../services/ai/build";
import { MAX_SCENE_ITEMS, parseSceneItem } from "../../services/ai/scene";
import { readStringField, scanArray } from "../../services/ai/streamParse";
import {
  parseDrawingIntent,
  type DrawingIntent,
} from "../../services/ai/intent";
import type { ApplyOptions, ElementsUpdater } from "./useScene";

export interface AIChatEntry {
  role: "user" | "model";
  parts: Array<{ text: string }>;
  /**
   * Sent to the model but not shown in the transcript. An automatic turn is a
   * prompt the user never typed, and five "your turn" bubbles in a row is noise.
   */
  hidden?: boolean;
}

const STORAGE_PREFIX = "collabdraw_ai_history:";

/** Gap left between existing content and a newly generated diagram. */
const PLACEMENT_GAP = 120;

/**
 * Delay between batches while the drawing appears.
 *
 * The reply arrives complete — with a response schema there is no partial JSON
 * worth parsing — but dropping twenty elements onto the canvas in one frame reads
 * as a jump. Revealing them in order over a few hundred milliseconds shows the
 * drawing being built, and matches the order the model intended things stacked.
 */
const REVEAL_STEP_MS = 45;

/**
 * Longest side of the canvas snapshot sent with each request.
 *
 * A written description cannot convey a freehand sketch — "freehand at (0,86)
 * size 17x14" says nothing about what was drawn. The model is multimodal, so
 * when there is drawing on the canvas it also gets a picture, alongside the
 * structured description. Bounded so the request stays small.
 */
const SNAPSHOT_MAX_DIMENSION = 896;

/**
 * When a snapshot is worth its tokens.
 *
 * The structured scene description already covers shapes, text and layout, so a
 * picture of those is redundant spend on every turn. Freehand strokes are the
 * one thing the description genuinely cannot convey — "freehand at (0,86) size
 * 17x14" is noise — so an image rides along only when such strokes exist.
 */
const SNAPSHOT_TOOLS = new Set(["Freehand"]);

/** JPEG quality for the snapshot; drawings tolerate mild loss well. */
const SNAPSHOT_JPEG_QUALITY = 0.7;

/**
 * How long the canvas must be still before an automatic turn fires.
 *
 * Deliberately generous: this fires when the user has *stopped working*, not
 * merely paused between strokes. A second is mid-drawing; three seconds of no
 * element changes reads as done.
 */
export const AUTO_RESPOND_DELAY_MS = 3000;

/** Grace period after the assistant writes, so its own edits never retrigger. */
export const AI_WRITE_SETTLE_MS = 400;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const storageKeyFor = (roomId: string | null): string =>
  `${STORAGE_PREFIX}${roomId ?? "local"}`;

const isChatEntry = (value: unknown): value is AIChatEntry => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as AIChatEntry;
  return (
    (entry.role === "user" || entry.role === "model") &&
    Array.isArray(entry.parts) &&
    entry.parts.every((part) => typeof part?.text === "string")
  );
};

const readHistory = (key: string): AIChatEntry[] => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isChatEntry) : [];
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage that throws on read throws on remove too (Safari's private
      // mode): there is nothing to clean up, and this runs during mount.
    }
    return [];
  }
};

const unionBounds = (elements: readonly Shape[]): BoundingBox | null => {
  if (elements.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    const bounds = getElementBounds(element);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

export interface UseAIAssistantProps {
  elementsRef: React.MutableRefObject<Shape[]>;
  applyElements: (updater: ElementsUpdater, options?: ApplyOptions) => Shape[];
  /** Commits the current elements as one undo step, after a streamed drawing. */
  commit: (elements?: Shape[]) => void;
  style: ElementStyle;
  roomId: string | null;
  /** Where to place a diagram when the canvas is empty. */
  getViewportCenter: () => { x: number; y: number };
  /** Brings the finished diagram into view. */
  onDiagramPlaced?: (bounds: BoundingBox) => void;
}

export interface AIAssistant {
  prompt: string;
  setPrompt: (prompt: string) => void;
  history: AIChatEntry[];
  isGenerating: boolean;
  error: string | null;
  dismissError: () => void;
  generate: (options?: { prompt?: string; hidden?: boolean }) => Promise<void>;
  resetConversation: () => void;
  /** When on, the assistant takes its turn as soon as the canvas settles. */
  autoRespond: boolean;
  setAutoRespond: (autoRespond: boolean) => void;
  /** Called when the *user* changed the canvas, to schedule an automatic turn. */
  notifyUserEdit: () => void;
}

export const useAIAssistant = ({
  elementsRef,
  applyElements,
  commit,
  style,
  roomId,
  getViewportCenter,
  onDiagramPlaced,
}: UseAIAssistantProps): AIAssistant => {
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<AIChatEntry[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Off until asked for. An automatic turn is a request nobody typed — it spends
   * the deployment's API quota and can redraw the canvas while you are still
   * looking at it, so it is opt-in per session rather than something to discover
   * happening.
   */
  const [autoRespond, setAutoRespond] = useState(false);

  const storageKey = useMemo(() => storageKeyFor(roomId), [roomId]);
  const historyLoadedRef = useRef(false);
  /** Bumped per request and on unmount, so a stale reply cannot land. */
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  /** Set while the assistant is writing, so its own edits do not retrigger it. */
  const aiWritingRef = useRef(false);
  const autoTimerRef = useRef<number | null>(null);
  const generateRef = useRef<AIAssistant["generate"] | null>(null);

  const styleRef = useRef(style);
  styleRef.current = style;

  const centerRef = useRef(getViewportCenter);
  centerRef.current = getViewportCenter;

  const placedRef = useRef(onDiagramPlaced);
  placedRef.current = onDiagramPlaced;

  useEffect(() => {
    historyLoadedRef.current = false;
    setPrompt("");
    setError(null);
    setHistory(readHistory(storageKey));
    historyLoadedRef.current = true;
  }, [storageKey]);

  useEffect(() => {
    if (!historyLoadedRef.current) {
      return;
    }

    try {
      if (history.length === 0) {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(storageKey, JSON.stringify(history));
      }
    } catch {
      // Storage full or unavailable: the transcript simply is not persisted.
    }
  }, [history, storageKey]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  const generate = useCallback(
    async ({
      prompt: override,
      hidden = false,
    }: { prompt?: string; hidden?: boolean } = {}) => {
      const submitted = (override ?? prompt).trim();

      if (!submitted || isGenerating) {
        return;
      }

      const sequence = ++requestSeqRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsGenerating(true);
      setError(null);

      const nextHistory: AIChatEntry[] = [
        ...history,
        { role: "user", parts: [{ text: submitted }], hidden },
      ];

      const sceneForRequest = describeScene(elementsRef.current);
      const knownIds = new Set(sceneForRequest.nodes.map((node) => node.id));

      // A picture of the canvas, but only when words fall short: freehand strokes
      // are the one thing the structured description cannot convey. Everything
      // else (shapes, text, layout) is already in `sceneForRequest`, so skipping
      // the image there saves its base64 payload on most turns.
      let snapshot: string | null = null;
      const hasDrawnMarks = elementsRef.current.some(
        (element) => !element.isDeleted && SNAPSHOT_TOOLS.has(element.tool),
      );

      if (hasDrawnMarks) {
        try {
          snapshot = exportSceneToDataURL(elementsRef.current, {
            maxDimension: SNAPSHOT_MAX_DIMENSION,
            scale: 1.5,
            format: "jpeg",
            quality: SNAPSHOT_JPEG_QUALITY,
          });
        } catch {
          // Rendering the snapshot must never block the request.
          snapshot = null;
        }
      }

      // Everything on the canvas before this turn, kept so a failed or diverged
      // stream can be rolled back cleanly.
      const baseElements = elementsRef.current;
      const stale = () =>
        requestSeqRef.current !== sequence || !mountedRef.current;

      /** Put the canvas back the way it was before an incremental scene began. */
      const restoreBase = () => {
        applyElements(() => baseElements, {
          commit: false,
          broadcast: "full",
        });
      };

      /** The world box a streamed scene maps into, matching the whole-spec build. */
      const streamSceneFrame = (placement: string): SceneFrame => {
        const existing = placement === "replace" ? [] : baseElements;
        const occupied = unionBounds(existing);
        const anchorBox = placement === "add" && occupied ? occupied : null;
        const origin = occupied
          ? { x: occupied.x, y: occupied.y + occupied.height + PLACEMENT_GAP }
          : (() => {
              const center = centerRef.current();
              return { x: center.x - 300, y: center.y - 220 };
            })();
        return sceneFrame(origin, anchorBox);
      };

      /** Append one item's elements as they stream in (no commit yet). */
      const appendStreamed = (built: Shape[], clearFirst: boolean) => {
        applyElements(
          (previous) => (clearFirst ? [...built] : [...previous, ...built]),
          {
            commit: false,
            // The clearing write is positional, so peers get the whole scene;
            // later appends only carry the new elements.
            broadcast: clearFirst ? "full" : "elements",
            changedIds: built.map((element) => element.id),
          },
        );
      };

      /**
       * The path for everything that cannot render item by item — grids, diagrams,
       * sequences, and any scene whose incremental parse diverged. Identical to the
       * behaviour before streaming: build the whole thing, then reveal it in order.
       */
      const revealWhole = async (intent: DrawingIntent) => {
        const replacing = intent.placement === "replace";
        const existing = replacing ? [] : elementsRef.current;
        const occupied = unionBounds(existing);
        const continuing = intent.placement === "add";

        const anchorGrid =
          continuing && intent.kind === "grid" ? sceneForRequest.grid : null;
        const anchorBox =
          continuing && intent.kind === "scene" && occupied ? occupied : null;

        const origin = occupied
          ? { x: occupied.x, y: occupied.y + occupied.height + PLACEMENT_GAP }
          : (() => {
              const center = centerRef.current();
              return { x: center.x - 300, y: center.y - 220 };
            })();

        const built = buildFromIntent(intent, {
          origin,
          style: styleRef.current,
          existing,
          anchorGrid,
          anchorBox,
        });

        if (built.elements.length === 0) {
          throw new Error("The drawing came back empty.");
        }

        if (stale()) {
          return;
        }

        const builtIds = new Set(built.elements.map((element) => element.id));
        const removedIds = new Set(built.removedIds);

        aiWritingRef.current = true;

        const batchSize =
          built.elements.length > 30 ? 4 : built.elements.length > 12 ? 3 : 2;

        for (
          let offset = 0;
          offset < built.elements.length;
          offset += batchSize
        ) {
          if (stale()) {
            return;
          }

          const batch = built.elements.slice(offset, offset + batchSize);
          const isFirst = offset === 0;
          const isLast = offset + batchSize >= built.elements.length;

          applyElements(
            (previous) => {
              if (!isFirst) {
                return [...previous, ...batch];
              }

              const base = replacing
                ? []
                : previous.filter(
                    (element) =>
                      !builtIds.has(element.id) && !removedIds.has(element.id),
                  );

              return [...base, ...batch];
            },
            {
              commit: isLast,
              broadcast: replacing && isFirst ? "full" : "elements",
              changedIds: batch.map((element) => element.id),
              deletedIds: isFirst ? built.removedIds : [],
            },
          );

          if (!isLast) {
            await delay(REVEAL_STEP_MS);
          }
        }

        placedRef.current?.(built.bounds);
      };

      // Incremental scene state, filled in as the stream arrives.
      let didStreamScene = false;
      let clearedForReplace = false;
      let frame: SceneFrame | null = null;
      let rawSeen = 0;
      let builtItemCount = 0;
      const streamedElements: Shape[] = [];

      try {
        const response = await fetch("/api/generate-drawing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            prompt: submitted,
            // The canvas travels as the structure it represents; a picture only
            // when there is drawing on it that the description cannot carry.
            scene: sceneForRequest,
            image: snapshot,
            history: nextHistory,
            stream: true,
          }),
        });

        if (!response.ok) {
          // Validation failures happen before streaming starts, so they still
          // arrive as JSON.
          const data = await response.json().catch(() => null);
          throw new Error(
            (data && typeof data.error === "string" && data.error) ||
              `Request failed with status ${response.status}`,
          );
        }

        if (!response.body) {
          throw new Error("The assistant returned an empty response.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let raw = "";
        let kind: string | null = null;
        let placement: string | null = null;

        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          // A newer request (or unmount) took over: stop touching the canvas.
          if (stale()) {
            await reader.cancel().catch(() => {});
            return;
          }

          raw += decoder.decode(value, { stream: true });

          if (!kind) {
            kind = readStringField(raw, "kind");
          }
          if (!placement) {
            placement = readStringField(raw, "placement");
          }

          /*
           * Only scenes render as they stream. A grid's cell size depends on the
           * widest cell across the whole board, and diagrams and sequences lay out
           * globally — none can be placed one item at a time without later items
           * shifting earlier ones, so they wait for the full reply and reveal then.
           */
          if (kind === "scene" && placement && !frame) {
            frame = streamSceneFrame(placement);
            didStreamScene = true;
            aiWritingRef.current = true;
          }

          if (didStreamScene && frame && placement) {
            const scan = scanArray(raw, "items");

            for (const candidate of scan.objects.slice(rawSeen)) {
              rawSeen += 1;

              // Stop at the same ceiling the whole-spec parser uses, so the
              // streamed set matches the authoritative one exactly.
              if (builtItemCount >= MAX_SCENE_ITEMS) {
                continue;
              }

              const item = parseSceneItem(candidate);
              if (!item) {
                continue;
              }

              const built = placeSceneItem(item, frame, styleRef.current);
              if (built.length === 0) {
                continue;
              }

              const clearFirst = !clearedForReplace && placement === "replace";
              streamedElements.push(...built);
              appendStreamed(built, clearFirst);
              clearedForReplace = clearedForReplace || placement === "replace";
              builtItemCount += 1;
            }
          }
        }

        raw += decoder.decode();

        if (stale()) {
          return;
        }

        // The authoritative result is the full-text parse under the response
        // schema. Streaming was a preview; this is what gets confirmed.
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }

        const intent = parsed ? parseDrawingIntent(parsed, knownIds) : null;

        if (!intent) {
          if (didStreamScene) {
            restoreBase();
          }
          throw new Error("The assistant returned nothing drawable.");
        }

        if (stale()) {
          return;
        }

        /*
         * The model can decline to draw ("wait"): the automatic turn used to make
         * it respond to every pause, so it added shapes while the user was still
         * arranging their own work. A wait rolls back any streamed preview and
         * records only its words.
         */
        if (intent.action === "wait") {
          if (didStreamScene) {
            restoreBase();
          }
          setHistory([
            ...nextHistory,
            {
              role: "model",
              parts: [{ text: intent.summary || intent.title || "(waiting)" }],
            },
          ]);
          setPrompt("");
          return;
        }

        setHistory([
          ...nextHistory,
          {
            role: "model",
            parts: [{ text: intent.summary || intent.title || "Done." }],
          },
        ]);

        /*
         * The streamed scene was built with the same validator, frame and builders
         * as the authoritative one and in the same order, so when the item counts
         * agree the two are identical but for ids and seeds. Keep what is already
         * on the canvas and commit it as a single undo step — no rebuild, no flash.
         */
        if (
          didStreamScene &&
          intent.kind === "scene" &&
          builtItemCount === intent.scene.items.length &&
          streamedElements.length > 0
        ) {
          commit();
          const bounds = unionBounds(streamedElements);
          if (bounds) {
            placedRef.current?.(bounds);
          }
          setPrompt("");
          return;
        }

        // Fallback: a kind that does not stream, or a scene that diverged. Undo any
        // partial scene first, then reveal the authoritative build as before.
        if (didStreamScene) {
          restoreBase();
        }

        await revealWhole(intent);
        setPrompt("");
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }
        if (requestSeqRef.current !== sequence) {
          return;
        }
        // Never leave a half-drawn, uncommitted scene behind.
        if (didStreamScene) {
          restoreBase();
        }
        setError(caught instanceof Error ? caught.message : "Unknown error");
      } finally {
        if (requestSeqRef.current === sequence && mountedRef.current) {
          setIsGenerating(false);
        }

        // Let the trailing scene change settle before edits count as the user's.
        window.setTimeout(() => {
          aiWritingRef.current = false;
        }, AI_WRITE_SETTLE_MS);
      }
    },
    [applyElements, commit, elementsRef, history, isGenerating, prompt],
  );

  generateRef.current = generate;

  /**
   * Schedule an automatic turn.
   *
   * Only once a conversation exists — the assistant should not start drawing on a
   * blank canvas nobody asked it about — and never in response to its own edits.
   */
  const notifyUserEdit = useCallback(() => {
    if (!autoRespond || aiWritingRef.current || history.length === 0) {
      return;
    }

    if (autoTimerRef.current !== null) {
      window.clearTimeout(autoTimerRef.current);
    }

    autoTimerRef.current = window.setTimeout(() => {
      autoTimerRef.current = null;

      if (aiWritingRef.current) {
        return;
      }

      void generateRef.current?.({
        prompt:
          'The user has paused. Look at what changed and decide: if something you could draw would clearly help now, draw it; otherwise reply with action "wait" and a short note.',
        hidden: true,
      });
    }, AUTO_RESPOND_DELAY_MS);
  }, [autoRespond, history.length]);

  useEffect(
    () => () => {
      if (autoTimerRef.current !== null) {
        window.clearTimeout(autoTimerRef.current);
      }
    },
    [],
  );

  const resetConversation = useCallback(() => {
    setHistory([]);
    setPrompt("");
    setError(null);

    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  }, [storageKey]);

  const dismissError = useCallback(() => setError(null), []);

  return {
    prompt,
    setPrompt,
    history,
    isGenerating,
    error,
    dismissError,
    generate,
    resetConversation,
    autoRespond,
    setAutoRespond,
    notifyUserEdit,
  };
};
