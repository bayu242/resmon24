import type { ElectrobunConfig } from "electrobun";

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
      "dist/mainview/index.html": "views/mainview/index.html",
      "dist/tabview/index.html": "views/tabview/index.html",
      "dist/assets": "views/assets",
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
} satisfies ElectrobunConfig;
