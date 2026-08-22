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
import { buildFromIntent } from "../../services/ai/build";
import { parseDrawingIntent } from "../../services/ai/intent";
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
 * Longest side of the canvas snapshot sent with each request.
 *
 * A written description cannot convey a freehand sketch — "freehand at (0,86)
 * size 17x14" says nothing about what was drawn. The model is multimodal, so it
 * gets a picture of the canvas alongside the structured description and can see
 * for itself. Bounded so the request stays small.
 */
const SNAPSHOT_MAX_DIMENSION = 896;

/**
 * Delay between batches while the drawing appears.
 *
 * The reply arrives complete — with a response schema there is no partial JSON
 * worth parsing — but dropping twenty elements onto the canvas in one frame reads
 * as a jump. Revealing them in order over a few hundred milliseconds shows the
 * drawing being built, and matches the order the model intended things stacked.
 */
const REVEAL_STEP_MS = 45;

/** How long the canvas must be still before an automatic turn fires. */
const AUTO_RESPOND_DELAY_MS = 1200;

/** Grace period after the assistant writes, so its own edits never retrigger. */
const AI_WRITE_SETTLE_MS = 400;

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
    window.localStorage.removeItem(key);
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
  style,
  roomId,
  getViewportCenter,
  onDiagramPlaced,
}: UseAIAssistantProps): AIAssistant => {
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<AIChatEntry[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

    // A picture of the canvas, so the model can see what a description cannot.
    let snapshot: string | null = null;
    try {
      snapshot = exportSceneToDataURL(elementsRef.current, {
        maxDimension: SNAPSHOT_MAX_DIMENSION,
        scale: 1.5,
      });
    } catch {
      // Rendering the snapshot must never block the request.
      snapshot = null;
    }

    try {
      const response = await fetch("/api/generate-drawing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          prompt: submitted,
          // The canvas travels as the structure it represents, plus a picture.
          scene: sceneForRequest,
          image: snapshot,
          history: nextHistory,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          (data && typeof data.error === "string" && data.error) ||
            `Request failed with status ${response.status}`,
        );
      }

      const intent = parseDrawingIntent(
        data?.intent,
        new Set(sceneForRequest.nodes.map((node) => node.id)),
      );

      if (!intent) {
        throw new Error("The assistant returned nothing drawable.");
      }

      // A newer request (or unmount) happened while this one was in flight.
      if (requestSeqRef.current !== sequence) {
        return;
      }

      setHistory([
        ...nextHistory,
        {
          role: "model",
          parts: [{ text: intent.summary || intent.title || "Done." }],
        },
      ]);

      const replacing = intent.placement === "replace";
      const existing = replacing ? [] : elementsRef.current;
      const occupied = unionBounds(existing);

      /*
       * Where the new content goes, driven by the model's stated placement.
       *
       * `add` continues what is there — a grid is written into the matching board
       * in place, and a scene is mapped onto the area the drawing occupies so
       * "finish this" lands on it. `beside` and `replace` both want clear space,
       * which is what stops a fresh rendering being stacked on top of the old one.
       */
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

      if (requestSeqRef.current !== sequence || !mountedRef.current) {
        return;
      }

      const builtIds = new Set(built.elements.map((element) => element.id));
      const removedIds = new Set(built.removedIds);

      /*
       * Reveal in order rather than in one frame. The first batch is the one that
       * clears or prunes; the last is the one that commits, so the whole drawing
       * is a single undo step however many batches it took.
       */
      aiWritingRef.current = true;

      const batchSize =
        built.elements.length > 30 ? 4 : built.elements.length > 12 ? 3 : 2;

      for (
        let offset = 0;
        offset < built.elements.length;
        offset += batchSize
      ) {
        if (requestSeqRef.current !== sequence || !mountedRef.current) {
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
            // Replacing the canvas is positional, so peers need the whole scene.
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
      setPrompt("");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return;
      }
      if (requestSeqRef.current !== sequence) {
        return;
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
    [applyElements, elementsRef, history, isGenerating, prompt],
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
        prompt: "I have made my move. Your turn — respond to what changed.",
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
