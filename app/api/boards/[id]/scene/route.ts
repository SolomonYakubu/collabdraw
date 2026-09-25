import { NextResponse, type NextRequest } from "next/server";

import {
  DATABASE_DISABLED_MESSAGE,
  ensureBoard,
  isDatabaseConfigured,
  saveBoardScene,
} from "../../../../lib/db";
import {
  MAX_SCENE_BYTES,
  getDeviceId,
  isValidBoardId,
  readViewport,
  withinByteLimit,
} from "../../../../lib/boardAccess";
import { clientIp, isAllowedRateLimit } from "../../../../lib/rateLimit";
import { restoreElements } from "../../../../services/canvas/elements";

type Params = { params: Promise<{ id: string }> };

/**
 * PUT /api/boards/:id/scene — offline / beacon fallback scene save.
 *
 * The socket server is the primary writer while a client is connected; this
 * path exists for solo/offline editing (sent via `navigator.sendBeacon` on
 * pagehide). Last-write-wins on `updated_at`.
 *
 * Accepts JSON `{ scene, viewport? }` or a raw beacon body (also JSON).
 */
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

    // This path can also create the board row (`ensureBoard` below), so it needs
    // the same cap as the explicit create/open endpoints.
    const ip = clientIp(request);
    if (!(await isAllowedRateLimit(`board-scene:${ip}`, 120, 60))) {
      return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    }

    const raw = await request.text();
    if (!withinByteLimit(raw, MAX_SCENE_BYTES)) {
      return NextResponse.json({ error: "Scene too large." }, { status: 413 });
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
    }

    const payload = body as { scene?: unknown; viewport?: unknown };
    const scene = restoreElements(payload?.scene);
    // Same validation as `POST /api/boards`: one reading of the viewport, so the
    // two save paths cannot drift into storing different kinds of nonsense.
    const viewport = readViewport(payload?.viewport);

    // Create-on-demand: a shared-link first save must not 404. Without a
    // device id there is no honest owner to record, so only the scene is saved.
    if (deviceId) {
      await ensureBoard(id, deviceId);
    }

    // Nothing written means there was no live row to write: unknown id, or a
    // board deleted before this flush landed. Reporting `{ ok: true }` for that
    // hid the difference between saved and gone.
    const saved = await saveBoardScene(id, scene, viewport);
    if (!saved) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PUT /api/boards/:id/scene failed:", error);
    return NextResponse.json({ error: "Could not save scene." }, { status: 500 });
  }
}
