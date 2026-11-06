import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The B-rep builder prompt embeds this file, read from disk at module load.
  outputFileTracingIncludes: { '/api/**': ['./src/lib/brep/cheatsheet.md'] },
};

export default nextConfig;
