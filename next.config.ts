import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    // Handle canvas for server-side compatibility
    config.externals = [...(config.externals || []), { canvas: "canvas" }];

    // No need for Konva-specific configurations anymore

    return config;
  },
};

export default nextConfig;
