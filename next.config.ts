import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cross-origin isolation is required for onnxruntime-web's WASM backend
  // to use SharedArrayBuffer (multi-threaded inference for the MeshSegNet
  // tooth/gingiva segmentation model) — without it, inference still works
  // but falls back to single-threaded WASM, roughly 3x slower.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
