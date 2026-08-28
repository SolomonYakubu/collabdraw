import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A production build normally writes to `.next`, which is also where `next
  // dev` keeps its own output — building while a dev server is running leaves
  // the two mixed and both fail with "Cannot find module ./<chunk>.js". Setting
  // NEXT_DIST_DIR builds (and serves) somewhere else, so a production check can
  // run beside a live dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  webpack: (config) => {
    // `canvas` is an optional native dependency of some server-side rendering
    // paths; keep it external so bundling does not try to compile it.
    config.externals = [...(config.externals || []), { canvas: "canvas" }];
    return config;
  },
  // NOTE: GEMINI_API_KEY is deliberately *not* listed under `env`. Anything
  // there is inlined into the client bundle at build time, which published the
  // key to every visitor. The API route reads `process.env.GEMINI_API_KEY`
  // directly on the server, which is where it belongs.
};

export default nextConfig;
