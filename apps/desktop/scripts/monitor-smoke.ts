// Local smoke test for the resmon24 desktop monitor server.
// Connects a Bun WebSocket client, performs the hello handshake, and counts
// resource_update/heartbeat traffic for 30 s.
import { MonitorServer } from "../src/bun/server";

const PORT = Number(process.env.PORT ?? 8765);
const server = new MonitorServer();
const state = await server.start(PORT, "0.0.0.0");
console.log("server running:", state.running, `on port ${PORT}`);

const counts = { update: 0, ping: 0, welcome: 0, config: 0, other: 0, errors: 0 };
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);

ws.onopen = () => {
  console.log("client open, sending hello");
  ws.send(
    JSON.stringify({
      type: "hello",
      proto: 1,
      ts: Date.now(),
      data: {
        deviceId: "smoke-test",
        firmware: "0.1.0",
        board: "d1_mini",
        capabilities: ["cpu", "memory", "clock"],
      },
    })
  );
};

ws.onmessage = (event) => {
  try {
    const msg = JSON.parse(String(event.data));
    switch (msg.type) {
      case "welcome":
        counts.welcome++;
        break;
      case "config":
        counts.config++;
        ws.send(JSON.stringify({ type: "ack", proto: 1, ts: Date.now(), id: msg.id, data: { ok: true } }));
        break;
      case "resource_update":
        counts.update++;
        break;
      case "ping":
        counts.ping++;
        ws.send(JSON.stringify({ type: "pong", proto: 1, ts: Date.now(), id: msg.id, data: {} }));
        break;
      default:
        counts.other++;
    }
  } catch {
    counts.errors++;
  }
};

ws.onerror = (e) => console.log("client error", e);
ws.onclose = () => console.log("client closed");

let report = 1;
const timer = setInterval(() => {
  console.log(`[${report * 5}s]`, JSON.stringify(counts));
  report++;
}, 5000);

setTimeout(() => {
  clearInterval(timer);
  const monitorState = server.getState();
  console.log("final:", JSON.stringify(counts), "server samplesSent:", monitorState.samplesSent, "lastError:", monitorState.lastError);
  try {
    ws.close();
  } catch {}
  server.stop();
  process.exit(counts.update > 10 ? 0 : 1);
}, 30000);
