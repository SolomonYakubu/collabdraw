"use client";

import { useState, useEffect } from "react";
import Canvas from "./components/Canvas";

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });

  // Handle window resize
  useEffect(() => {
    setMounted(true);

    const calculateCanvasSize = () => {
      const maxWidth = Math.min(window.innerWidth - 40, 1200);
      const maxHeight = window.innerHeight - 160;

      setCanvasSize({
        width: maxWidth,
        height: maxHeight,
      });
    };

    calculateCanvasSize();
    window.addEventListener("resize", calculateCanvasSize);

    return () => window.removeEventListener("resize", calculateCanvasSize);
  }, []);

  if (!mounted) {
    return null; // Prevent SSR rendering issues
  }

  return (
    <main className="flex min-h-screen flex-col items-center p-5 lg:p-10">
      <div className="max-w-7xl w-full">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">CollabDraw</h1>
          <p className="text-gray-600">Real-time collaborative drawing board</p>
        </header>

        <div className="bg-gray-50 p-4 rounded-lg">
          <Canvas
            width={canvasSize.width}
            height={canvasSize.height}
            initialTool="Freehand"
            initialColor="#000000"
            isCollaborative={true}
          />
        </div>
      </div>
    </main>
  );
}
