/**
 * A `pg` stand-in — the seam the board routes and `app/lib/db` share.
 *
 * Faking the driver rather than `app/lib/db` is deliberate: the routes are then
 * tested through the real query layer, so what a request does and the SQL it
 * sends are asserted together, and `db.ts`'s own rules (the pool cache, the TLS
 * decision, the not-configured error) are exercised by the same tests.
 *
 * The fake is dumb on purpose. It records what it was asked and answers with rows
 * the test queued; it does not pretend to be a database.
 */
export type RecordedQuery = { text: string; params: unknown[] };

/** Every query sent, in order. */
export const queries: RecordedQuery[] = [];

/** What `new Pool()` was constructed with, for the TLS and sizing assertions. */
export let poolOptions: Record<string, unknown> | null = null;

/** Listeners registered on the pool, so the idle-error path can be driven. */
export const poolListeners = new Map<string, (error: Error) => void>();

/** How many pools were constructed — the module cache is meant to make it one. */
export let poolsCreated = 0;

let answers: unknown[][] = [];
let failure: Error | null = null;

/** Queue the row sets the next queries resolve with, in order. */
export const answerWith = (...sets: unknown[][]) => {
  answers = [...sets];
};

/** Make every query reject, the way an unreachable database does. */
export const failWith = (error: Error) => {
  failure = error;
};

/** One line of SQL, whitespace-collapsed, for a readable assertion. */
export const flatten = (text: string) => text.replace(/\s+/g, " ").trim();

/** The flattened SQL of every query, in order. */
export const sql = () => queries.map((entry) => flatten(entry.text));

export const reset = () => {
  queries.length = 0;
  poolListeners.clear();
  poolOptions = null;
  poolsCreated = 0;
  answers = [];
  failure = null;
  // `app/lib/db` caches its pool here, so a freshly imported copy of the module
  // would otherwise reuse the pool built for the previous test.
  delete (globalThis as { __cdPool?: unknown }).__cdPool;
};

export class Pool {
  constructor(options: Record<string, unknown>) {
    poolOptions = options;
    poolsCreated += 1;
  }

  on(event: string, handler: (error: Error) => void) {
    poolListeners.set(event, handler);
    return this;
  }

  async query(text: string, params: unknown[] = []) {
    queries.push({ text, params });
    if (failure) {
      throw failure;
    }
    return { rows: answers.shift() ?? [] };
  }
}
