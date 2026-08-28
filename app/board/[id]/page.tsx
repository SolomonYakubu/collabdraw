import { notFound } from "next/navigation";

import Canvas from "../../components/Canvas";
import {
  ensureBoard,
  getBoard,
  isDatabaseConfigured,
  type BoardRow,
} from "../../lib/db";
import { getDeviceId, isValidBoardId } from "../../lib/boardAccess";
import { restoreElements } from "../../services/canvas/elements";

/**
 * The editor, in a room. Loads (or creates on demand) the board on the server so
 * the scene is painted on first render, independent of the collaboration
 * socket — this is what makes a board survive after the Redis snapshot TTL
 * expires.
 *
 * `?adopt=local` means the session was just started from the canvas at `/`:
 * the drawing that was on screen there carries into the room.
 */
export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ adopt?: string }>;
}) {
  const { id } = await params;
  const { adopt } = await searchParams;
  if (!isValidBoardId(id)) {
    notFound();
  }

  const deviceId = await getDeviceId();

  // Create-on-demand: opening an unknown id (a share link, a collaborator's
  // link) upserts the row rather than 404ing.
  //
  // A database failure must not take the editor down: without a reachable
  // Postgres the app still draws and still collaborates, it just has nowhere to
  // save. So this degrades to an empty scene instead of throwing a 500. When
  // there is no `DATABASE_URL` at all, skip the call entirely — an expected
  // configuration, not an error worth a stack trace on every render.
  let board: BoardRow | null = null;
  if (isDatabaseConfigured) {
    try {
      // Only create with a real device id — a row stamped with a placeholder
      // owner cannot be renamed or deleted by anyone afterwards. Middleware
      // issues the cookie on this same request, so `deviceId` is empty only
      // when the visitor blocks cookies.
      if (deviceId) {
        await ensureBoard(id, deviceId);
      }
      board = await getBoard(id);
    } catch (error) {
      console.error(`Could not load board ${id}:`, error);
    }
  }

  const initialElements = restoreElements(board?.scene);

  return (
    <main className="fixed inset-0 overflow-hidden">
      <Canvas
        initialTool="Select"
        isCollaborative
        boardId={id}
        initialTitle={board?.title}
        initialElements={initialElements}
        initialViewport={board?.viewport ?? null}
        adoptLocalScene={adopt === "local"}
      />
    </main>
  );
}
