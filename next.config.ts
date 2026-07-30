import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / heavy deps must stay external to the server bundle.
  // undici: bundling breaks its lazy llhttp-WASM load on first dispatch.
  serverExternalPackages: ["better-sqlite3", "sharp", "@google/genai", "undici"],
};

export default nextConfig;
