import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
    // Provides Path2D and a minimal `document` on top of node-canvas, so the
    // renderer can be exercised without a browser.
    setupFiles: ["./app/testSetup.ts"],
  },
});
