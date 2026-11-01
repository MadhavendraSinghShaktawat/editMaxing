import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** During development the browser talks to Vite, and Vite signs requests with this Mac's engine token. */
const tokenFile = join(process.env.DOJO_HOME ?? join(homedir(), "Library/Application Support/Shifu Dojo"), "token");
const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: "http://127.0.0.1:51791", changeOrigin: true, headers: { Authorization: `Bearer ${token}` } } } },
});
