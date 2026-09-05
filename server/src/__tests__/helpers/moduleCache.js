/**
 * Swapping a CommonJS module out from under the one being tested.
 *
 * The server is CommonJS, and `vi.mock` only rewrites ESM imports — a `require`
 * reaches the real module regardless. So the seam is Node's own module cache: a
 * fake planted under a module's resolved path is what the next `require` of it
 * returns, as long as it is planted *before* the module under test loads.
 *
 * Paths are written the way the server writes them, relative to `server/src`:
 * `"./config.js"`, `"./jobs/generationQueue.js"`, or a bare package name like
 * `"bullmq"`. Everything planted or freshly loaded is dropped again by `reset()`,
 * which matters because a Vitest worker is shared between test files — a
 * singleton left behind is one test file deciding another's answer.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const nodeRequire = createRequire(import.meta.url);

/** `server/src/`, the directory the server's own relative requires start from. */
const SRC = new URL("../../", import.meta.url);

const resolve = (specifier) =>
  nodeRequire.resolve(
    specifier.startsWith(".")
      ? fileURLToPath(new URL(specifier, SRC))
      : specifier,
  );

export const createModuleCache = () => {
  /** Every path this cache has touched, so `reset` can drop all of it. */
  const touched = new Set();

  const forget = (path) => {
    delete nodeRequire.cache[path];
  };

  return {
    /** Install `exports` as the module at `specifier`. */
    plant: (specifier, exports) => {
      const path = resolve(specifier);
      touched.add(path);
      nodeRequire.cache[path] = {
        id: path,
        filename: path,
        loaded: true,
        exports,
      };
      return exports;
    },

    /** Load `specifier` fresh, so it closes over whatever is planted now. */
    load: (specifier) => {
      const path = resolve(specifier);
      touched.add(path);
      forget(path);
      return nodeRequire(path);
    },

    /** The real module, untouched — for a constant a fake should not invent. */
    real: (specifier) => nodeRequire(resolve(specifier)),

    /** Leave no singletons behind. */
    reset: () => {
      for (const path of touched) forget(path);
      touched.clear();
    },
  };
};
