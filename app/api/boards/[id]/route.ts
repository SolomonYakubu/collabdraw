import { NextResponse, type NextRequest } from "next/server";

import {
  claimBoard,
  DATABASE_DISABLED_MESSAGE,
  getBoard,
  isDatabaseConfigured,
  softDeleteBoard,
  updateBoardTitle,
} from "../../../lib/db";
import {
  getDeviceId,
  isUnclaimedOwner,
  isValidBoardId,
  mayWriteBoardMetadata,
} from "../../../lib/boardAccess";

type Params = { params: Promise<{ id: string }> };

/**
 * Authorize a metadata write, taking ownership of an unclaimed board on the way
 * through, so the next request sees a real owner.
 *
 * Returns the response to send when the caller may not proceed, or null when it
 * may.
 */
async function authorize(
  id: string,
  deviceId: string,
): Promise<NextResponse | null> {
  const board = await getBoard(id);
  if (!board) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!mayWriteBoardMetadata(board.owner_device_id, deviceId)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  if (isUnclaimedOwner(board.owner_device_id)) {
    await claimBoard(id, deviceId);
  }
  return null;
}

/** PATCH /api/boards/:id — rename. Only the owner device may rename. */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    if (!isDatabaseConfigured) {
      return NextResponse.json(
        { error: DATABASE_DISABLED_MESSAGE },
        { status: 503 },
      );
    }
    const { id } = await params;
    if (!isValidBoardId(id)) {
      return NextResponse.json({ error: "Invalid board id." }, { status: 400 });
    }
    const deviceId = await getDeviceId();

    const body = await request.json().catch(() => null);
    const title =
      typeof body?.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (!title) {
      return NextResponse.json({ error: "Title required." }, { status: 400 });
    }

    const refusal = await authorize(id, deviceId);
    if (refusal) {
      return refusal;
    }

    await updateBoardTitle(id, title);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PATCH /api/boards/:id failed:", error);
    return NextResponse.json({ error: "Could not update board." }, { status: 500 });
  }
}

/** DELETE /api/boards/:id — soft delete. Only the owner device may delete. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    if (!isDatabaseConfigured) {
      return NextResponse.json(
        { error: DATABASE_DISABLED_MESSAGE },
        { status: 503 },
      );
    }
    const { id } = await params;
    if (!isValidBoardId(id)) {
      return NextResponse.json({ error: "Invalid board id." }, { status: 400 });
    }
    const deviceId = await getDeviceId();

    const refusal = await authorize(id, deviceId);
    // Deleting something already gone is the state the caller asked for.
    if (refusal && refusal.status !== 404) {
      return refusal;
    }
    if (refusal) {
      return NextResponse.json({ ok: true });
    }

    await softDeleteBoard(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/boards/:id failed:", error);
    return NextResponse.json({ error: "Could not delete board." }, { status: 500 });
  }
}
