import { NextResponse, type NextRequest } from "next/server";

import {
  DATABASE_DISABLED_MESSAGE,
  ensureBoard,
  isDatabaseConfigured,
  recordBoardOpen,
} from "../../../../lib/db";
import { getDeviceId, isValidBoardId } from "../../../../lib/boardAccess";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/boards/:id/open — record that this device opened the board, so a
 * board reached via someone else's share link appears in the device's recents.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    if (!isDatabaseConfigured) {
      return NextResponse.json(
        { error: DATABASE_DISABLED_MESSAGE },
        { status: 503 },
      );
    }
    const { id } = await params;
    if (!isValidBoardId(id)) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    const deviceId = await getDeviceId();
    if (!deviceId) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    await ensureBoard(id, deviceId);
    await recordBoardOpen(id, deviceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST open failed:", error);
    return NextResponse.json({ error: "Could not record open." }, { status: 500 });
  }
}
