/**
 * Cross-tab notifications.
 *
 * The `storage` event is the browser's only push channel between two tabs of the
 * same origin, and it has exactly the property that makes it usable here: it
 * fires in every *other* tab, never in the one that made the change. A listener
 * therefore cannot hear its own writes, and needs no echo suppression or write
 * counter to tell them apart.
 *
 * Two tabs of this app both hold a whole scene and a display name in
 * localStorage, and before this existed each blind-overwrote the other.
 */

/** Excalidraw's `storage` debounce, for the same reason: a burst reads once. */
export const STORAGE_SYNC_DEBOUNCE_MS = 50;

/**
 * Call `onChange` when another tab writes `key`, with whatever it wrote (`null`
 * when the entry was removed, or the whole store cleared).
 *
 * Coalesced, because one user action in the other tab can touch a key more than
 * once and the reader only ever wants the settled value. Returns an unsubscribe.
 */
export function subscribeToStorageKey(
  key: string,
  onChange: (value: string | null) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  let timer: number | null = null;

  const listener = (event: StorageEvent) => {
    // sessionStorage raises this event too, and it is not shared between tabs.
    if (event.storageArea && event.storageArea !== window.localStorage) {
      return;
    }
    // A null key means `clear()`, which takes this key with it.
    if (event.key !== null && event.key !== key) {
      return;
    }

    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = null;
      // Re-read rather than trusting `newValue`: after a coalesced burst the
      // store holds the settled value, and `clear()` reports none at all.
      let current: string | null = null;
      try {
        current = window.localStorage.getItem(key);
      } catch {
        // Storage went away mid-session; treat it as empty.
      }
      onChange(current);
    }, STORAGE_SYNC_DEBOUNCE_MS);
  };

  window.addEventListener("storage", listener);

  return () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    window.removeEventListener("storage", listener);
  };
}
