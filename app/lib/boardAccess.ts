import { cookies } from "next/headers";

import type { Viewport } from "../types/shapes";

/** Server-readable anonymous device id (set by middleware.ts). */
export const DEVICE_COOKIE = "cd_device";

/** Max serialized scene we will write to Postgres. */
export const MAX_SCENE_BYTES = 2 * 1024 * 1024;

/** Max thumbnail data-URL size (jpeg at maxDimension 480 is ~20-40KB). */
export const MAX_THUMBNAIL_BYTES = 200 * 1024;

/** Read the device id from the request cookies (empty string when absent). */
export async function getDeviceId(): Promise<string> {
  const store = await cookies();
  return store.get(DEVICE_COOKIE)?.value ?? "";
}

/**
 * Owner values that belong to no device.
 *
 * A board row can be created by something that has no device cookie to stamp:
 * the socket server flushing a room's scene, or a request whose cookie had not
 * been issued yet. Those rows used to be unrenameable and undeletable forever,
 * because no caller could ever match the owner. They are treated as unclaimed
 * instead, and the first device to write to one takes ownership — consistent
 * with the rest of the model, where anyone holding the link can already edit
 * the drawing.
 */
export const PLACEHOLDER_OWNER_IDS = ["", "server", "anonymous"] as const;

/** True when `ownerDeviceId` is a placeholder rather than a real device. */
export function isUnclaimedOwner(ownerDeviceId: string | null): boolean {
  return (
    ownerDeviceId === null ||
    (PLACEHOLDER_OWNER_IDS as readonly string[]).includes(ownerDeviceId)
  );
}

/**
 * May `deviceId` rename or delete a board owned by `ownerDeviceId`? True for the
 * owner, and for any real device when the board is unclaimed.
 */
export function mayWriteBoardMetadata(
  ownerDeviceId: string | null,
  deviceId: string,
): boolean {
  if (!deviceId) {
    return false;
  }
  return ownerDeviceId === deviceId || isUnclaimedOwner(ownerDeviceId);
}

/** Reject a payload whose UTF-8 size exceeds `max` bytes. */
export function withinByteLimit(value: string, max: number): boolean {
  return Buffer.byteLength(value, "utf8") <= max;
}

/**
 * Board ids are `nanoid(10)` values, and the same string is used as the room id.
 * Anything can appear in the `/board/[id]` path, and several routes create a
 * board on demand, so the shape is checked before it reaches the database — an
 * unbounded id would otherwise be insertable as a primary key.
 */
const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidBoardId(id: unknown): id is string {
  return typeof id === "string" && BOARD_ID_PATTERN.test(id);
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Accept a viewport only if it is fully well-formed; otherwise store none.
 *
 * Shared by both save paths — `POST /api/boards` and the beacon scene write —
 * because a half-read viewport is worse than none: the board reopens scrolled
 * into empty space with nothing on screen and no way to tell why. `Infinity` is
 * the reason the check is `isFinite` rather than `typeof`: JSON has no literal
 * for it, but `1e999` parses to it, and `JSON.stringify` then writes the column
 * as `null` — a zoom that no client can restore.
 */
export function readViewport(value: unknown): Viewport | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { zoom?: unknown; scroll?: unknown };
  const scroll = candidate.scroll as { x?: unknown; y?: unknown } | undefined;
  if (
    !isFiniteNumber(candidate.zoom) ||
    !scroll ||
    !isFiniteNumber(scroll.x) ||
    !isFiniteNumber(scroll.y)
  ) {
    return null;
  }
  return { zoom: candidate.zoom, scroll: { x: scroll.x, y: scroll.y } };
}
