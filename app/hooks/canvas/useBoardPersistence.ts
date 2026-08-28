"use client";

import { useEffect, useRef } from "react";

import type { Shape, Viewport } from "../../types/shapes";
import { exportSceneToDataURL } from "../../services/canvas/renderer";

interface UseBoardPersistenceOptions {
  boardId?: string;
  /** Scene state; used as the change signal for debounced thumbnail capture. */
  elements: Shape[];
  elementsRef: React.MutableRefObject<Shape[]>;
  viewportRef: React.MutableRefObject<Viewport>;
  /** When false, the client owns saving (the socket server is not writing). */
  isConnected: boolean;
}

const THUMBNAIL_DEBOUNCE_MS = 4000;

/**
 * Client-side board persistence that the socket server can't do:
 *  - record that this device opened the board (for the dashboard recents),
 *  - capture a thumbnail a few seconds after edits settle,
 *  - flush the scene via `sendBeacon` on unload when offline (the socket
 *    server is the primary writer whenever it is connected).
 */
export function useBoardPersistence({
  boardId,
  elements,
  elementsRef,
  viewportRef,
  isConnected,
}: UseBoardPersistenceOptions): void {
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  // Record the open once per board.
  useEffect(() => {
    if (!boardId) return;
    void fetch(`/api/boards/${boardId}/open`, { method: "POST" }).catch(
      () => {},
    );
  }, [boardId]);

  // Debounced thumbnail capture after edits settle.
  useEffect(() => {
    if (!boardId) return;
    const timer = window.setTimeout(() => {
      const dataUrl = exportSceneToDataURL(elementsRef.current, {
        format: "jpeg",
        maxDimension: 480,
        quality: 0.7,
        background: "#ffffff",
      });
      if (!dataUrl) return;
      void fetch(`/api/boards/${boardId}/thumbnail`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      }).catch(() => {});
    }, THUMBNAIL_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
    // `elements` identity changes on every edit — that is the debounce signal.
  }, [boardId, elements, elementsRef]);

  // Offline scene flush on unload. Skipped while the socket is connected,
  // because the server persists the authoritative merged scene.
  useEffect(() => {
    if (!boardId) return;

    const flush = () => {
      if (isConnectedRef.current) return;
      const payload = JSON.stringify({
        scene: elementsRef.current,
        viewport: viewportRef.current,
      });
      try {
        navigator.sendBeacon(
          `/api/boards/${boardId}/scene`,
          new Blob([payload], { type: "application/json" }),
        );
      } catch {
        // Beacon unavailable — best effort only.
      }
    };

    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [boardId, elementsRef, viewportRef]);
}
