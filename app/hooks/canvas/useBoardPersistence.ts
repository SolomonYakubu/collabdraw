"use client";

import { useCallback, useEffect, useRef } from "react";

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
 *  - flush the scene when the board is left while offline (the socket server is
 *    the primary writer whenever it is connected).
 *
 * The last two both have to survive *leaving*, and there are two unrelated ways
 * to leave. Closing the tab fires `pagehide`, where the document is about to
 * stop existing and only a beacon still gets out. A client-side route change —
 * the "My boards" link, the back button — fires nothing at all: React unmounts
 * the tree and the page lives on. Listening for the first only is what left an
 * offline board's last edits unwritten, so the cleanups below do work rather
 * than just removing listeners.
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

  /** Set while the debounce is armed, so a departure knows one is owed. */
  const thumbnailOwedRef = useRef(false);

  const captureThumbnail = useCallback(() => {
    thumbnailOwedRef.current = false;
    if (!boardId) return;

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
  }, [boardId, elementsRef]);

  // Debounced thumbnail capture after edits settle.
  useEffect(() => {
    if (!boardId) return;

    thumbnailOwedRef.current = true;
    const timer = window.setTimeout(captureThumbnail, THUMBNAIL_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
    // `elements` identity changes on every edit — that is the debounce signal.
  }, [boardId, captureThumbnail, elements]);

  /**
   * Send the scene to the board row. `beacon` is for the one moment the page
   * will not outlive the call, and it is also the only transport with a size
   * ceiling — around 64KB in Chromium, where the route itself accepts 2MB. Over
   * that, `sendBeacon` answers false rather than throwing, so a refusal falls
   * through to a keepalive request: same ceiling in Chromium, but a beacon can
   * also be refused for reasons a request is not (a queue already full, a
   * browser without the API), and those cases then work.
   */
  const flushScene = useCallback(
    (transport: "request" | "beacon") => {
      if (!boardId) return;
      // The socket server is writing the authoritative merged scene.
      if (isConnectedRef.current) return;

      const url = `/api/boards/${boardId}/scene`;
      const payload = JSON.stringify({
        scene: elementsRef.current,
        viewport: viewportRef.current,
      });

      if (transport === "beacon") {
        let queued = false;
        try {
          queued = navigator.sendBeacon(
            url,
            new Blob([payload], { type: "application/json" }),
          );
        } catch {
          // No beacon support at all; the request below is the fallback.
        }
        if (queued) return;
      }

      void fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: payload,
        // Only worth asking for when the document is going: a keepalive body is
        // itself capped at 64KB, and this transport otherwise has no limit.
        keepalive: transport === "beacon",
      }).catch(() => {});
    },
    [boardId, elementsRef, viewportRef],
  );

  // Departure. Skipped while the socket is connected, because the server
  // persists the authoritative merged scene.
  useEffect(() => {
    if (!boardId) return;

    const onPageHide = () => flushScene("beacon");

    // A hidden tab is still a live document that may well come back, so this is
    // an ordinary request — no size ceiling — rather than a beacon.
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushScene("request");
    };

    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onHidden);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onHidden);

      // Left by a route change: nothing announced it, and the page survives the
      // call, so the scene goes out as a plain request and a thumbnail still
      // owed is taken now. Neither is done on `pagehide` in this shape —
      // capturing means rendering the whole scene while the browser is tearing
      // the page down, into exactly the size of payload a beacon refuses.
      flushScene("request");
      if (thumbnailOwedRef.current) captureThumbnail();
    };
  }, [boardId, captureThumbnail, flushScene]);
}
