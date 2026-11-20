import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Autoposter",
        short_name: "Autoposter",
        description: "Approve and schedule your stream clips",
        theme_color: "#0f0f12",
        background_color: "#0f0f12",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // never cache the API or the videos, only the app shell
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  build: { outDir: "dist", emptyOutDir: true },
  // `npm run web` = UI with hot reload, talking to `wrangler dev` on 8787
  server: { host: true, proxy: { "/api": "http://127.0.0.1:8787" } },
});
