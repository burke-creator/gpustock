import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// SSR on Workers. The Worker entry is OURS (see wrangler.jsonc -> main:
// src/worker.ts) because this project also needs Durable Object exports plus
// `scheduled` and `queue` handlers, none of which Astro emits. Astro is
// delegated to as the terminal handler for page routes.
export default defineConfig({
  output: "server",
  adapter: cloudflare({
    imageService: "compile",
  }),
  site: "https://gpustock.io",
  build: {
    // Keep hashed asset names — Workers Static Assets serves these immutably.
    assets: "_astro",
  },
  vite: {
    build: { target: "es2022" },
  },
});
