import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * Dev mode proxies /api and /events to a running prediff daemon.
 * The daemon picks a per-repo port; find it via `prediff status --json`
 * (the `url` field) and run: PREDIFF_URL=http://127.0.0.1:<port> bun run dev
 */
const daemon = process.env["PREDIFF_URL"] ?? "http://127.0.0.1:4870";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // @pierre/diffs imports the full Shiki registry by default. Prediff's
    // fine-grained facade keeps syntax grammars lazy and avoids shipping every
    // language and theme in the production asset manifest.
    alias: [
      {
        find: /^shiki$/,
        replacement: fileURLToPath(new URL("./src/lib/shiki.ts", import.meta.url)),
      },
      {
        find: /^@pierre\/theming\/themes$/,
        replacement: fileURLToPath(
          new URL("./src/lib/pierreThemes.ts", import.meta.url),
        ),
      },
    ],
  },
  // Built assets are served by the daemon from public/ (see src/server/server.ts).
  build: {
    outDir: "../public",
    emptyOutDir: true,
    target: "es2022",
    // Everything (entry, workers, lazy grammar chunks) lands under /assets/,
    // which is the single static route the daemon exposes.
    assetsDir: "assets",
  },
  worker: {
    // ES format so the highlight worker can lazy-import per-language grammars.
    format: "es",
  },
  server: {
    proxy: {
      "/api": { target: daemon, changeOrigin: true },
      "/events": { target: daemon, changeOrigin: true },
    },
  },
});
