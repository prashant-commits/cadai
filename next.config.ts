import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    proxyClientMaxBodySize: '6mb',
  },
  serverExternalPackages: ['@electric-sql/pglite'],
  // `next dev` treats 127.0.0.1 as cross-origin and blocks its chunks and HMR (403); dev servers here are reached through an SSH tunnel on 127.0.0.1.
  allowedDevOrigins: ['127.0.0.1'],
  // The B-rep builder prompt embeds this file, read from disk at module load.
  outputFileTracingIncludes: { '/api/**': ['./src/lib/brep/cheatsheet.md'] },
  // The Docker image (Dockerfile) builds with NEXT_OUTPUT=standalone; other builds keep the default output.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
};

export default nextConfig;
