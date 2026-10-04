import type { ElectrobunConfig } from "electrobun";

// `category` and `description` are consumed by scripts/package-linux.ts
// (freedesktop .desktop entry + deb control), which the upstream config type
// doesn't model yet.
type Resmon24Config = ElectrobunConfig & {
  build: { linux: { category?: string; description?: string } };
};

export default {
  app: {
    name: "Resmon24",
    identifier: "com.bayu242.resmon24",
    version: "1.0.0",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
      external: [],
    },
    copy: {
      "dist/mainview": "views/mainview",
    },
    mac: { bundleCEF: false },
    linux: {
      category: "Utility",
      bundleCEF: false,
      description: "A simple system monitor display on oled screen for Linux",
      icon: "assets/icon.png",
    },
    win: { bundleCEF: false },
  },
} satisfies Resmon24Config;
