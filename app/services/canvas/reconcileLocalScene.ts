/**
 * Merging one tab's scene with another's.
 *
 * Both tabs of this app autosave the whole scene under one localStorage key, so
 * the last writer used to win outright: draw in tab A, switch to tab B, and B's
 * next autosave replaced everything A had done. This is the merge that runs
 * instead, on the reading side, when `storageSync` reports that the other tab
 * wrote.
 *
 * It is deliberately a pure function of its three inputs so the interesting part
 * — what happens to an element only one tab has — is testable without a browser.
 *
 * Two things make the merge harder than "take the newer element":
 *
 *  - **There are no tombstones.** A deleted element is gone from the array, so
 *    "missing" is ambiguous: either the other tab deleted it, or the other tab
 *    has never seen it. `knownIds` is what disambiguates — the ids this tab has
 *    already exchanged with the store. A missing id we know was shared was
 *    deleted; a missing id we do not know is simply new here.
 *  - **It has to terminate.** Adopting a merge changes local state, which
 *    triggers this tab's own autosave, which fires the other tab's listener. So
 *    the merge is confluent: the incoming array's order wins (the tab that just
 *    saved decides z-order), and an already-settled scene is returned *by
 *    reference* so the caller can skip the adopt entirely and the exchange stops.
 *
 * The viewport is not merged. Scroll and zoom are per-tab by design — adopting
 * another tab's camera would yank the view out from under whoever is drawing.
 */
import type { Shape } from "../../types/shapes";

/**
 * Do these two scenes hold the same elements, at the same versions, in the same
 * order? Used to short-circuit; compares `id`/`version` pairs rather than deep
 * contents because every mutation bumps `version`.
 */
export function areScenesEquivalent(
  a: readonly Shape[],
  b: readonly Shape[],
): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every(
    (element, index) =>
      element.id === b[index].id && element.version === b[index].version,
  );
}

/**
 * Merge the scene another tab just wrote (`incoming`) into this tab's
 * (`local`).
 *
 * `knownIds` is every id this tab has already shared with the store — see the
 * module comment. Returns `local` itself when nothing changed, so callers can
 * test `result === local` and do nothing.
 */
export function reconcileScenes(
  local: Shape[],
  incoming: readonly Shape[],
  knownIds: ReadonlySet<string>,
): Shape[] {
  const localById = new Map(local.map((element) => [element.id, element]));
  const incomingIds = new Set(incoming.map((element) => element.id));

  // The incoming order is the spine: whoever saved last decides z-order, which
  // is what makes repeated merges converge instead of trading places forever.
  const merged: Shape[] = [];

  for (const element of incoming) {
    const mine = localById.get(element.id);
    if (!mine) {
      // Only they have it. Either they just drew it, or we deleted it and they
      // have not heard yet — and we only know it is the latter if we had it.
      if (!knownIds.has(element.id)) {
        merged.push(element);
      }
      continue;
    }
    // Both have it: the higher version is the later edit. A tie keeps our own
    // object, so its identity — and the render cache keyed on it — survives.
    merged.push(element.version > mine.version ? element : mine);
  }

  for (const element of local) {
    if (incomingIds.has(element.id)) {
      continue;
    }
    // Only we have it. Symmetric with the case above: an id we know was shared
    // and is now absent from their scene is one they deleted, so it goes.
    if (!knownIds.has(element.id)) {
      merged.push(element);
    }
  }

  return areScenesEquivalent(local, merged) ? local : merged;
}
