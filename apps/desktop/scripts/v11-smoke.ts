// v1.1 smoke test: monitor server session flow, diagnostics, reconnect
// accounting, config push, and the persisted last-applied config store.

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

process.env.XDG_CONFIG_HOME = "/tmp/opencode/xdg-smoke";

const { MonitorServer } = await import(`${ROOT}/src/bun/server.ts`);
const configStore = await import(`${ROOT}/src/bun/config-store.ts`);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frame = { type: string; id?: string; data?: any };

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  });
}

function nextFrames(ws: WebSocket, ms: number): Promise<Frame[]> {
  const frames: Frame[] = [];
  const onMessage = (event: MessageEvent) => {
    try {
      frames.push(JSON.parse(String(event.data)));
    } catch {}
  };
  ws.addEventListener("message", onMessage);
  return new Promise((resolve) => {
    setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      resolve(frames);
    }, ms);
  });
}

console.log("server session flow");
const server = new MonitorServer();
const started = await server.start(18765, "127.0.0.1");
check("server starts", started.running === true);
check("diagnostics block present", !!started.diagnostics);
check("default screens", started.config.screens.join("|") === "cpu|memory|clock");

let ws = await openSocket("ws://127.0.0.1:18765/");
ws.send(
  JSON.stringify({
    type: "hello",
    proto: 1,
    ts: Date.now(),
    data: { deviceId: "smoke-dev", firmware: "0.1.0", board: "d1_mini" },
  })
);

let frames = await nextFrames(ws, 1500);
const welcome = frames.find((f) => f.type === "welcome");
const config = frames.find((f) => f.type === "config");
check("welcome received", !!welcome);
check("config includes rotateMs", typeof config?.data?.rotateMs === "number");
check("config includes brightness", typeof config?.data?.brightness === "number");
check("config omits dimAfterMs", config?.data?.dimAfterMs === undefined, JSON.stringify(config?.data));
check("config omits showConnection", config?.data?.showConnection === undefined);

await sleep(3000);
frames = [...frames, ...(await nextFrames(ws, 500))];
const updates = frames.filter((f) => f.type === "resource_update");
check("resource_update streamed", updates.length >= 1, `${updates.length}`);
const sample = updates.at(-1)?.data ?? {};
check("sample has cpu", !!sample.cpu);
check("sample has memory", !!sample.memory);
check("sample has network rates", typeof sample.network?.rxBytesPerSec === "number");
check("sample has gpu (nvidia-smi present on host)", !!sample.gpu);
check("sample has temperature group", !!sample.temperature);
check("sample fits 1 KB budget", JSON.stringify(updates.at(-1)).length <= 1024);

let state = server.getState();
const client0 = state.clients[0];
check("client messages counted", (client0?.messagesIn ?? 0) >= 1, String(client0?.messagesIn));
check("client not stale", client0?.stale === false);
check("first session has 0 reconnects", client0?.reconnects === 0);
check("diagnostics sessions = 1", state.diagnostics.sessions === 1);

server.updateConfig({ rotateMs: 4000, screens: ["cpu", "memory", "gpu", "network", "sensors"] });
state = server.getState();
check("rotateMs accepted", state.config.rotateMs === 4000, String(state.config.rotateMs));
check("sensors screen accepted", state.config.screens.includes("sensors"));

const afterConfig = await nextFrames(ws, 1200);
const pushed = afterConfig.find((f) => f.type === "config");
check("config pushed to device with rotateMs", pushed?.data?.rotateMs === 4000, JSON.stringify(pushed?.data));
check("pushed config omits dimAfterMs", pushed?.data?.dimAfterMs === undefined);

// heartbeat RTT: server pings every 10s
const pingIds: string[] = [];
const rttWatch = nextFrames(ws, 11000);
const listener = (event: MessageEvent) => {
  try {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "ping") {
      pingIds.push(frame.id);
      ws.send(JSON.stringify({ type: "pong", proto: 1, ts: Date.now(), id: frame.id, data: {} }));
    }
  } catch {}
};
ws.addEventListener("message", listener);
await rttWatch;
ws.removeEventListener("message", listener);
check("heartbeat ping observed", pingIds.length >= 1, `${pingIds.length}`);
state = server.getState();
check("rtt measured from pong", typeof state.clients[0]?.rttMs === "number", String(state.clients[0]?.rttMs));

// reconnect accounting with the same deviceId
ws.close();
await sleep(300);
ws = await openSocket("ws://127.0.0.1:18765/");
ws.send(
  JSON.stringify({
    type: "hello",
    proto: 1,
    ts: Date.now(),
    data: { deviceId: "smoke-dev", firmware: "0.1.0", board: "d1_mini" },
  })
);
await nextFrames(ws, 800);
state = server.getState();
check("reconnect counted", state.clients[0]?.reconnects === 1, String(state.clients[0]?.reconnects));
check("diagnostics reconnects = 1", state.diagnostics.reconnects === 1, String(state.diagnostics.reconnects));
check("diagnostics sessions = 2", state.diagnostics.sessions === 2, String(state.diagnostics.sessions));

console.log("screens");
const screensModule = await import(`${ROOT}/src/stubs/screens.ts`);
check("basic screens are single metrics", screensModule.BASIC_SCREENS.length === 7);
check(
  "basic screens are single tokens",
  screensModule.BASIC_SCREENS.every((p: any) => screensModule.parseScreen(p.id).length === 1)
);
check(
  "wifi basic screen present",
  screensModule.BASIC_SCREENS.some((p: any) => p.id === "wifi")
);
check("wifi screen valid", screensModule.isValidScreen("wifi"));
check("wifi label renders", screensModule.screenLabel("wifi") === "WIFI");
check(
  "combo presets are valid ids",
  screensModule.COMBO_SCREENS.length === 6 &&
    screensModule.COMBO_SCREENS.every((p: any) => screensModule.isValidScreen(p.id))
);
check(
  "composite round trip",
  screensModule.makeScreenId(screensModule.parseScreen("cpu+memory+gpu+network")) ===
    "cpu+memory+gpu+network"
);
check("label renders", screensModule.screenLabel("clock+sensors") === "CLOCK + SENS");
check("garbage id rejected", !screensModule.isValidScreen("cpu+bogus"));
check(
  "sanitize drops garbage and dupes",
  screensModule.sanitizeScreens(["bogus", "cpu+memory", "cpu+memory", ""]).join("|") ===
    "cpu+memory"
);

server.updateConfig({ screens: ["cpu+memory+gpu+network", "clock+sensors"] });
state = server.getState();
check(
  "composite screens accepted by server",
  state.config.screens.join("|") === "cpu+memory+gpu+network|clock+sensors",
  state.config.screens.join("|")
);
const compositePush = (await nextFrames(ws, 1200)).find((f) => f.type === "config");
check(
  "composite config pushed to device",
  compositePush?.data?.screens?.join("|") === "cpu+memory+gpu+network|clock+sensors",
  JSON.stringify(compositePush?.data?.screens)
);

ws.close();
const stopped = server.stop();
check("server stops", stopped.running === false);

console.log("config store");
const { rmSync } = await import("node:fs");
rmSync(configStore.configPath(), { force: true });
check("no config file returns null", configStore.loadConfig() === null);

server.updateConfig({ intervalMs: 1500 });
const configFile = Bun.file(configStore.configPath());
check("server persists config on update", await configFile.exists(), configStore.configPath());
const persisted = JSON.parse(await configFile.text());
check("store is versioned JSON", persisted.version === 1 && !!persisted.config);
check("persisted intervalMs", persisted.config.intervalMs === 1500, String(persisted.config.intervalMs));
check(
  "persisted screens from last update",
  persisted.config.screens.join("|") === "cpu+memory+gpu+network|clock+sensors",
  JSON.stringify(persisted.config.screens)
);

configStore.saveConfig({
  intervalMs: 2000,
  screens: ["cpu", "wifi", "bogus", "cpu"],
  rotateMs: 9000,
  brightness: 300,
  timezone: "WIB-7",
});
const loaded = configStore.loadConfig();
check("config reloaded from disk", loaded !== null);
check("garbage and duplicate screens dropped", loaded?.screens.join("|") === "cpu|wifi", JSON.stringify(loaded?.screens));
check("brightness clamped", loaded?.brightness === 255, String(loaded?.brightness));
check("timezone kept", loaded?.timezone === "WIB-7", String(loaded?.timezone));
check("intervalMs kept", loaded?.intervalMs === 2000, String(loaded?.intervalMs));
check("rotateMs kept", loaded?.rotateMs === 9000, String(loaded?.rotateMs));

configStore.saveConfig({ intervalMs: 1000, screens: [], rotateMs: 5000 });
check("empty stored screens default to clock", configStore.loadConfig()?.screens.join("|") === "clock");

console.log("screen defaults");
server.updateConfig({ screens: ["wifi"] });
state = server.getState();
check("wifi screen accepted by server", state.config.screens.join("|") === "wifi", state.config.screens.join("|"));

server.updateConfig({ screens: ["bogus"] });
state = server.getState();
check("all-invalid screens default to clock", state.config.screens.join("|") === "clock", state.config.screens.join("|"));

server.updateConfig({ screens: [] });
state = server.getState();
check("empty screens default to clock", state.config.screens.join("|") === "clock", state.config.screens.join("|"));
check(
  "clock default persisted",
  JSON.parse(await configFile.text()).config.screens.join("|") === "clock"
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
