import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / heavy deps must stay external to the server bundle.
  serverExternalPackages: ["better-sqlite3", "sharp", "@google/genai"],
};

export default nextConfig;
