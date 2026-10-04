import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler"]],
      },
    }),
    tailwindcss(),
  ],
  root: "src",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        mainview: path.resolve(__dirname, "src/mainview/index.html"),
      },
    },
  },
  resolve: {
    alias: [
      {
        find: /^electrobun\/view$/,
        replacement: path.resolve(__dirname, ".hutch/devkit/api/browser/index.ts"),
      },
      {
        find: /^electrobun\/browser\/ui$/,
        replacement: path.resolve(__dirname, ".hutch/devkit/api/browser/ui/index.ts"),
      },
      {
        find: /^electrobun\/browser\/ui\/jsx-runtime$/,
        replacement: path.resolve(__dirname, ".hutch/devkit/api/browser/ui/jsx-runtime.ts"),
      },
      {
        find: /^electrobun\/browser\/ui\/jsx-dev-runtime$/,
        replacement: path.resolve(__dirname, ".hutch/devkit/api/browser/ui/jsx-dev-runtime.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src/tabview/app") },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
