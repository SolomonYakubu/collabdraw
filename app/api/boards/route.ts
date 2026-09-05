import { NextResponse, type NextRequest } from "next/server";
import { nanoid } from "nanoid";

import {
  createBoard,
  DATABASE_DISABLED_MESSAGE,
  isDatabaseConfigured,
} from "../../lib/db";
import {
  getDeviceId,
  MAX_SCENE_BYTES,
  readViewport,
  withinByteLimit,
} from "../../lib/boardAccess";
import { isAllowedRateLimit } from "../../lib/rateLimit";
import { restoreElements } from "../../services/canvas/elements";
import type { Shape, Viewport } from "../../types/shapes";

/**
 * POST /api/boards — create a board owned by the caller's device.
 *
 * The body may carry the scene currently on screen (`{ scene, viewport }`),
 * which is how "Save to my boards" promotes a localStorage-only canvas to a
 * saved board in one request.
 */
export async function POST(request: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return NextResponse.json(
        { error: DATABASE_DISABLED_MESSAGE },
        { status: 503 },
      );
    }

    const deviceId = await getDeviceId();
    if (!deviceId) {
      return NextResponse.json({ error: "No device id." }, { status: 400 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
    if (!(await isAllowedRateLimit(`board-create:${ip}`, 30, 60))) {
      return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    }

    let title: string | undefined;
    let scene: Shape[] | undefined;
    let viewport: Viewport | null = null;
    try {
      const body = await request.json();
      if (typeof body?.title === "string") title = body.title.slice(0, 200);

      if (body?.scene !== undefined) {
        // Never trust the payload: the same validation the editor uses when
        // hydrating a scene, plus the size ceiling the save routes share.
        const serialized = JSON.stringify(body.scene);
        if (!withinByteLimit(serialized, MAX_SCENE_BYTES)) {
          return NextResponse.json(
            { error: "That drawing is too large to save." },
            { status: 413 },
          );
        }
        scene = restoreElements(body.scene);
        viewport = readViewport(body.viewport);
      }
    } catch {
      // No body (or unparseable): an empty untitled board is a fine result.
    }

    const id = nanoid(10);
    await createBoard(id, deviceId, title, scene, viewport);
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    console.error("POST /api/boards failed:", error);
    return NextResponse.json(
      { error: "Could not reach the board store. Nothing was saved." },
      { status: 500 },
    );
  }
}
