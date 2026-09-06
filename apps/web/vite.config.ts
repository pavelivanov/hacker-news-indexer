import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: process.env["MANUAL_REVIEW_WEB_PORT"] === "5174" ? 5174 : 5173,
    strictPort: true,
    proxy: {
      "/v1": {
        target: `http://127.0.0.1:${process.env["MANUAL_REVIEW_API_PORT"] === "3101" ? "3101" : "3100"}`,
      },
    },
  },
});
