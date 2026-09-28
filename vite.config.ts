import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

// The admin UI. Built into dist/web and served by the admin server; in dev, Vite serves it and
// proxies /admin/api to the server on ADMIN_PORT.
export default defineConfig({
  root: "web",
  plugins: [svelte()],
  resolve: {
    alias: { $engine: fileURLToPath(new URL("./src/engine", import.meta.url)) },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/admin/api": `http://localhost:${process.env.ADMIN_PORT ?? 8080}` },
    fs: { allow: [".."] },
  },
});
