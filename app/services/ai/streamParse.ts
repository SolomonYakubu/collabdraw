/**
 * Incremental extraction from a streaming JSON reply.
 *
 * The drawing endpoint streams the model's JSON one chunk at a time. Nothing here
 * tries to parse the *whole* thing early — a response schema already guarantees the
 * finished text is valid, and the authoritative parse still runs at the end. What
 * this does is pull out the two things worth acting on before the reply is complete:
 *
 *  - the envelope scalars (`kind`, `placement`), which decide whether and how to
 *    render progressively, and which arrive first;
 *  - each completed object of a payload array (`scene.items`), so a scene can be
 *    drawn shape by shape as the model emits it.
 *
 * The payload arrays hold flat objects, so a brace-depth walk with string and escape
 * awareness is enough — no dependency, and it degrades gracefully: a half-written
 * object is simply not emitted until its closing brace arrives.
 */

export interface ArrayScan {
  /** Every fully-closed object found in the array so far, in order. */
  objects: unknown[];
  /** True once the array's own closing `]` has been seen. */
  closed: boolean;
  /** True once the array's opening `[` has been seen. */
  started: boolean;
}

const EMPTY_SCAN: ArrayScan = { objects: [], closed: false, started: false };

/**
 * Read a top-level string field once it is fully present.
 *
 * Used only for enum-valued envelope fields (`kind`, `placement`), whose values
 * contain no escapes — so a value that is still streaming (no closing quote yet)
 * simply does not match, and the caller waits. Returns null until the whole
 * `"field":"value"` pair has arrived.
 */
export const readStringField = (
  buffer: string,
  field: string,
): string | null => {
  // `[^"\\]*` stops at the first quote or backslash, so it matches a complete,
  // unescaped value and nothing partial.
  const match = new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]*)"`).exec(buffer);
  return match ? match[1] : null;
};

/**
 * Walk the named array and return every object whose closing brace has arrived.
 *
 * Re-scans from the array start on each call, which is fine for the small arrays
 * involved (tens of items) and keeps the function pure — the caller remembers how
 * many objects it has already handled and slices off the new ones.
 */
export const scanArray = (buffer: string, key: string): ArrayScan => {
  const opener = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(buffer);
  if (!opener) {
    return EMPTY_SCAN;
  }

  const objects: unknown[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  let closed = false;

  for (let i = opener.index + opener[0].length; i < buffer.length; i += 1) {
    const char = buffer[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) {
        objectStart = i;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        // Balanced by construction, so this parse cannot fail; guarded anyway.
        try {
          objects.push(JSON.parse(buffer.slice(objectStart, i + 1)));
        } catch {
          // Leave it out; the authoritative parse at the end is the safety net.
        }
        objectStart = -1;
      }
    } else if (char === "]" && depth === 0) {
      closed = true;
      break;
    }
  }

  return { objects, closed, started: true };
};
