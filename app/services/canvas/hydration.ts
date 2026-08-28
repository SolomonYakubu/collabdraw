import type { Shape } from "../../types/shapes";

/**
 * What to do with the scene the server sends on `canvas-state-sync` (join).
 *
 * `adopt`      — take the incoming scene as the local baseline.
 * `push-local` — keep the local scene and broadcast it to the room instead.
 */
export type InitialSceneAction = "adopt" | "push-local";

/**
 * A board is hydrated from Postgres by the `/board/[id]` server component, so
 * the editor can already hold a scene before the socket finishes joining. If
 * the socket server has no cached room state yet (cold process, expired Redis
 * TTL) it answers the join with an *empty* scene — adopting that would blank a
 * board that was just loaded from the database.
 *
 * So: an empty hydration is refused whenever the local scene is non-empty, and
 * the local scene is pushed up to seed the room instead. Every other case
 * adopts the incoming scene, including a legitimately empty board.
 *
 * This only governs join hydration. A live full update (a peer's clear or undo)
 * arrives on a separate channel and is always applied, or "clear canvas" could
 * never propagate.
 */
export function decideInitialScene(
  incoming: readonly Shape[],
  local: readonly Shape[],
): InitialSceneAction {
  return incoming.length === 0 && local.length > 0 ? "push-local" : "adopt";
}
