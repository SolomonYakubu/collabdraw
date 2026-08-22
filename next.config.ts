import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
