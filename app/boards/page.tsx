import Dashboard from "../components/Dashboard";
import {
  isDatabaseConfigured,
  listBoardsForDevice,
  type BoardSummary,
} from "../lib/db";
import { getDeviceId } from "../lib/boardAccess";

/**
 * The board gallery — boards this browser has saved to the cloud. It is a
 * destination reached from the canvas menu ("My boards"), not the front door:
 * `/` is the canvas, the way excalidraw.com works.
 */
export default async function BoardsPage() {
  const deviceId = await getDeviceId();

  // No board store (unconfigured, or unreachable) shows the gallery's notice
  // rather than a 500 — the editor itself does not need Postgres to run.
  let boards: BoardSummary[] = [];
  let unavailable = !isDatabaseConfigured;
  if (deviceId && isDatabaseConfigured) {
    try {
      boards = await listBoardsForDevice(deviceId);
    } catch (error) {
      console.error("Could not list boards:", error);
      unavailable = true;
    }
  }

  return <Dashboard boards={boards} unavailable={unavailable} />;
}
