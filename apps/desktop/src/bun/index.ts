import { BrowserWindow, BrowserView, Utils, Updater } from "electrobun/bun";
import type { MonitorState, SetMonitorConfigParams } from "../stubs/types";
import { MonitorServer, DEFAULT_CONFIG } from "./server";
import { loadConfig } from "./config-store";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

async function getViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    const viewUrl = `${DEV_SERVER_URL}/mainview/index.html`;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(viewUrl, { method: "HEAD" });
        if (res.ok) {
          console.log(`HMR enabled: Vite dev server at ${viewUrl}`);
          return viewUrl;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return "views://mainview/index.html";
}

// ── Monitor server (WebSocket + mDNS for ESP8266 devices) ─────────────────────

const monitor = new MonitorServer(loadConfig() ?? DEFAULT_CONFIG);

// ── Monitor RPC (renderer ↔ Bun) ──────────────────────────────────────────────

const rpc = BrowserView.defineRPC<any>({
  maxRequestTime: 60000,
  handlers: {
    requests: {
      get_monitor_state: async (): Promise<MonitorState> => monitor.getState(),
      get_latest_sample: async () => monitor.getLatestSample(),
      set_monitor_config: async (params: SetMonitorConfigParams): Promise<MonitorState> =>
        monitor.updateConfig(params),
      start_monitor: async (): Promise<MonitorState> => monitor.start(),
      stop_monitor: async (): Promise<MonitorState> => monitor.stop(),
    },
    messages: {} as any,
  },
});

// ── Window ────────────────────────────────────────────────────────────────────

const url = await getViewUrl();

const mainWindow = new BrowserWindow({
  title: "Resmon24",
  url,
  frame: { width: 1100, height: 750, x: 100, y: 100 },
  titleBarStyle: "hiddenInset",
  transparent: false,
  rpc,
});

mainWindow.on("close", () => Utils.quit());

// Auto-start so devices can connect as soon as the app launches.
const state = await monitor.start();
console.log(
  `[Bun] monitor server ${state.running ? "running" : "NOT running"} on ws://${state.hostname}:${state.port}` +
    (state.lastError ? ` (${state.lastError})` : "")
);

console.log("✅ Resmon24 started");
