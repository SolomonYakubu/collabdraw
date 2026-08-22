"use client";

import Canvas from "./components/Canvas";

/**
 * The editor fills the viewport and measures itself, so there is no longer any
 * window-size bookkeeping here (and no `mounted` gate that returned `null` on
 * the first paint).
 */
export default function Home() {
  return (
    <main className="fixed inset-0 overflow-hidden">
      <Canvas initialTool="Select" isCollaborative />
    </main>
  );
}
