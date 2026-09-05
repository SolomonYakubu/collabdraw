import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  /*
   * `tsconfig.json` sets `jsx: "preserve"` because Next.js does the compiling in
   * the app. Nothing compiles it here, so esbuild is told to use React's
   * automatic runtime — without this, JSX in a test becomes
   * `React.createElement` and every `.tsx` test dies on "React is not defined".
   */
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    /*
     * `node` is the default because most of what is worth testing here is pure —
     * geometry, layout, validation — and node is the cheapest place to run it.
     * A file that needs a DOM opts in for itself with a
     * `// @vitest-environment jsdom` docblock; `app/testSetup.ts` only shims
     * what the environment is missing, so both work off one setup.
     */
    environment: "node",
    /*
     * Discovery is Vitest's default glob (any `*.test.*` under any language),
     * deliberately not narrowed: `app/` needs `.tsx`, and `server/`, `scripts/`
     * and `middleware.ts` are all testable too. A narrower list is how those
     * trees came to be structurally untestable.
     */
    exclude: [...configDefaults.exclude, ".next/**", "coverage/**"],
    setupFiles: ["./app/testSetup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Everything that ships, whether or not it currently has a test — the
      // point of measuring is to see the gaps.
      include: ["app/**", "server/src/**", "scripts/**", "middleware.ts"],
      exclude: [
        "app/**/__tests__/**",
        "server/src/**/__tests__/**",
        "app/testSetup.ts",
        "app/**/*.d.ts",
        "app/globals.css",
      ],
    },
  },
});
