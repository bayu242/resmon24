// KPI #6 spot check: desktop overhead while streaming to a fake device.

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { MonitorServer } = await import(`${ROOT}/src/bun/server.ts`);

const server = new MonitorServer();
await server.start(18766, "127.0.0.1");

const ws = new WebSocket("ws://127.0.0.1:18766/");
await new Promise((resolve, reject) => {
  ws.addEventListener("open", () => resolve(null), { once: true });
  ws.addEventListener("error", () => reject(new Error("connect failed")), { once: true });
});
ws.send(
  JSON.stringify({
    type: "hello",
    proto: 1,
    ts: Date.now(),
    data: { deviceId: "kpi6", firmware: "0.1.0", board: "d1_mini" },
  })
);

const cpuStart = process.cpuUsage();
const wallStart = Date.now();
const samples: number[] = [];

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  samples.push(process.memoryUsage().rss);
}

const cpu = process.cpuUsage(cpuStart);
const wallMs = Date.now() - wallStart;
const cpuPercent = ((cpu.user + cpu.system) / 1000 / wallMs) * 100;
const rssMb = samples.map((s) => s / 1024 / 1024);
const peakRss = Math.max(...rssMb);

console.log(`samples received: ${server.getState().samplesSent}`);
console.log(`wall: ${wallMs} ms`);
console.log(`cpu: ${cpuPercent.toFixed(2)}% (KPI < 2%)`);
console.log(`rss peak: ${peakRss.toFixed(1)} MB (KPI < 150 MB)`);

ws.close();
server.stop();
process.exit(cpuPercent < 2 && peakRss < 150 ? 0 : 1);
