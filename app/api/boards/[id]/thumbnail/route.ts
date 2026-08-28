import { NextResponse, type NextRequest } from "next/server";

import {
  DATABASE_DISABLED_MESSAGE,
  ensureBoard,
  getThumbnail,
  isDatabaseConfigured,
  saveThumbnail,
} from "../../../../lib/db";
import {
  MAX_THUMBNAIL_BYTES,
  getDeviceId,
  isValidBoardId,
  withinByteLimit,
} from "../../../../lib/boardAccess";

type Params = { params: Promise<{ id: string }> };

/** GET /api/boards/:id/thumbnail — returns `{ dataUrl }` or `{ dataUrl: null }`. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    // The gallery just wants a picture or nothing, so keep the shape it reads
    // even when there is no store to read from.
    if (!isDatabaseConfigured) {
      return NextResponse.json({ dataUrl: null });
    }
    const { id } = await params;
    if (!isValidBoardId(id)) {
      return NextResponse.json({ dataUrl: null }, { status: 400 });
    }
    const dataUrl = await getThumbnail(id);
    return NextResponse.json({ dataUrl });
  } catch (error) {
    console.error("GET thumbnail failed:", error);
    return NextResponse.json({ dataUrl: null });
  }
}

/** PUT /api/boards/:id/thumbnail — store a jpeg data URL for the gallery. */
export async function PUT(request: NextRequest, { params }: Params) {
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
    const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";
    if (!dataUrl.startsWith("data:image/")) {
      return NextResponse.json({ error: "Invalid image." }, { status: 400 });
    }
    if (!withinByteLimit(dataUrl, MAX_THUMBNAIL_BYTES)) {
      return NextResponse.json({ error: "Thumbnail too large." }, { status: 413 });
    }

    if (deviceId) {
      await ensureBoard(id, deviceId);
    }
    await saveThumbnail(id, dataUrl);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PUT thumbnail failed:", error);
    return NextResponse.json({ error: "Could not save thumbnail." }, { status: 500 });
  }
}
