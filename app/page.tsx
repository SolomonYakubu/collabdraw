import { redirect } from "next/navigation";

import Canvas from "./components/Canvas";
import { CollaborationContextProvider } from "./context/CollaborationContext";

/**
 * The canvas. Opening the app puts you straight on it, with whatever you drew
 * last already restored from localStorage — no gallery, no "new board" step.
 * This is excalidraw.com's front door, and for the same reason: drawing should
 * not require an account or a decision.
 *
 * Saving is an option in the main menu ("Save to my boards"), which mints a
 * board in Postgres and moves you to `/board/<id>`. Legacy `?roomId=x` share
 * links redirect there too.
 *
 * The collaboration provider is mounted with a `null` room, so `Canvas` can use
 * the context unconditionally while no socket is opened here.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ roomId?: string }>;
}) {
  const { roomId } = await searchParams;
  if (roomId) {
    redirect(`/board/${roomId}`);
  }

  return (
    <main className="fixed inset-0 overflow-hidden">
      <CollaborationContextProvider roomId={null}>
        <Canvas initialTool="Select" isCollaborative={false} />
      </CollaborationContextProvider>
    </main>
  );
}
