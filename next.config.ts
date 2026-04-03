import type { NextConfig } from "next";

const usesTurbopack = process.argv.includes("--turbopack");

const nextConfig: NextConfig = {
  distDir: usesTurbopack ? ".next-turbo" : ".next",
  experimental: {
    serverActions: {
      bodySizeLimit: "500mb",
    },
  },
};

export default nextConfig;
