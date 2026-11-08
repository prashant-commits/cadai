import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    proxyClientMaxBodySize: '6mb',
  },
  serverExternalPackages: ['@electric-sql/pglite'],
  // The B-rep builder prompt embeds this file, read from disk at module load.
  outputFileTracingIncludes: { '/api/**': ['./src/lib/brep/cheatsheet.md'] },
};

export default nextConfig;
