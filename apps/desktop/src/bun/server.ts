// resmon24 monitor WebSocket server.
//
// Runs in the Bun main process. Accepts ESP8266 device connections, drives the
// session lifecycle (hello -> welcome -> config -> resource_update stream) and
// heartbeat (ping/pong), enforces the protocol's 1 KB message budget, and
// exposes state for the renderer.
//
// Uses Bun's built-in WebSocket server (Bun.serve) so no extra transport
// dependency is required.

import type { Server, ServerWebSocket } from "bun";
import os from "node:os";
import {
  PROTOCOL_VERSION,
  type AckMessage,
  type ConfigMessage,
  type ErrorMessage,
  type HelloMessage,
  type PingMessage,
  type PongMessage,
  type ResourceUpdateMessage,
  type WelcomeMessage,
} from "@resmon24/protocol";
import type { MonitorClient, MonitorConfig, MonitorState, SetMonitorConfigParams } from "../stubs/types";
import { sanitizeScreens } from "../stubs/screens";
import { saveConfig } from "./config-store";
import { advertiseMonitor, type Advertiser } from "./discovery";
import { collectMetrics } from "./metrics";

const SERVER_VERSION = "0.1.0";
const MAX_MESSAGE_BYTES = 1024;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 10000;
const MIN_ROTATE_MS = 2000;
const MAX_ROTATE_MS = 60000;
const HEARTBEAT_INTERVAL_MS = 10000;
const MAX_BUFFERED_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 30000;
const SILENCE_TIMEOUT_MS = 45000;

interface ClientData {
  id: string;
  remoteAddress: string;
  connectedAt: number;
  lastSeenAt: number;
  helloAt: number | null;
  deviceId?: string;
  firmware?: string;
  board?: string;
  timezone?: string;
  sessionId?: string;
  configAcked: boolean;
  sentCount: number;
  messagesIn: number;
  rttMs: number | null;
  reconnects: number;
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export const DEFAULT_CONFIG: MonitorConfig = {
  intervalMs: 1000,
  screens: ["cpu", "memory", "clock"],
  rotateMs: 5000,
  brightness: 200,
};

export class MonitorServer {
  private server: Server<ClientData> | null = null;
  private readonly clients = new Map<ServerWebSocket<ClientData>, ClientData>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private advertiser: Advertiser | null = null;
  private latest: ResourceUpdateMessage | null = null;
  private config: MonitorConfig;
  private samplesSent = 0;
  private lastSampleAt: number | null = null;
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private hostname = "0.0.0.0";
  private port = 8765;
  private collecting = false;
  private collectStartAt = 0;
  private tickCount = 0;
  private tickIdle = 0;
  private sessions = 0;
  private reconnectTotal = 0;
  private closedByServer = 0;
  private readonly sessionCounts = new Map<string, number>();
  private readonly pingSentAt = new Map<string, number>();
  private lastTrimWarnAt = 0;

  constructor(config: MonitorConfig = DEFAULT_CONFIG) {
    this.config = { ...config, screens: [...config.screens] };
  }

  async start(port = this.port, hostname = "0.0.0.0"): Promise<MonitorState> {
    if (this.server) return this.getState();

    this.port = port;
    this.hostname = hostname;

    try {
      this.server = Bun.serve<ClientData>({
        port,
        hostname,
        fetch: (req, srv) => {
          const url = new URL(req.url);
          if (url.pathname === "/health") return new Response("ok");
          if (srv.upgrade(req, { data: this.newClientData() })) return undefined;
          return new Response("resmon24 monitor: WebSocket endpoint\n", { status: 426 });
        },
        websocket: {
          open: (ws) => {
            this.clients.set(ws, ws.data);
            console.log(`[monitor] device connected (${this.clients.size} total)`);
          },
          message: (ws, raw) => {
            void this.handleMessage(ws, raw);
          },
          close: (ws, code, message) => {
            const reason = message ? String(message) : "";
            this.clients.delete(ws);
            console.log(
              `[monitor] device disconnected (code=${code}${reason ? ` reason=${reason}` : ""}, ${this.clients.size} left)`
            );
          },
        },
      });

      this.startedAt = Date.now();
      this.lastError = null;
      this.restartTimer();
      this.startHeartbeat();
      void collectMetrics().catch(() => {});

      this.advertiser = await advertiseMonitor({
        port,
        protocolVersion: PROTOCOL_VERSION,
        onError: (message) => {
          this.lastError = message;
        },
      });
    } catch (error) {
      this.lastError = `server start failed: ${String(error)}`;
      this.server = null;
      this.startedAt = null;
    }

    return this.getState();
  }

  stop(): MonitorState {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;

    for (const ws of this.clients.keys()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    this.advertiser?.stop();
    this.advertiser = null;
    this.server?.stop(true);
    this.server = null;
    this.startedAt = null;

    return this.getState();
  }

  updateConfig(partial: SetMonitorConfigParams): MonitorState {
    const next: MonitorConfig = { ...this.config };

    if (partial.intervalMs !== undefined) next.intervalMs = clamp(partial.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
    if (partial.rotateMs !== undefined) next.rotateMs = clamp(partial.rotateMs, MIN_ROTATE_MS, MAX_ROTATE_MS);
    if (partial.brightness !== undefined) next.brightness = clamp(partial.brightness, 0, 255);
    if (partial.screens !== undefined) {
      const screens = sanitizeScreens(partial.screens);
      next.screens = screens.length > 0 ? screens : ["clock"];
    }
    if (partial.timezone !== undefined) next.timezone = partial.timezone;

    const intervalChanged = next.intervalMs !== this.config.intervalMs;
    this.config = next;
    saveConfig(this.config);

    if (intervalChanged && this.server) this.restartTimer();
    if (this.server) {
      for (const ws of this.clients.keys()) this.sendConfig(ws);
    }

    return this.getState();
  }

  getState(): MonitorState {
    const now = Date.now();
    const staleAfter = Math.max(3 * this.config.intervalMs, SILENCE_TIMEOUT_MS / 3);
    return {
      running: this.server !== null,
      hostname: this.hostname,
      port: this.port,
      startedAt: this.startedAt,
      config: { ...this.config, screens: [...this.config.screens] },
      clients: [...this.clients.values()].map(
        (client): MonitorClient => ({
          id: client.id,
          remoteAddress: client.remoteAddress,
          deviceId: client.deviceId,
          firmware: client.firmware,
          board: client.board,
          timezone: client.timezone,
          connectedAt: client.connectedAt,
          lastSeenAt: client.lastSeenAt,
          configAcked: client.configAcked,
          messagesIn: client.messagesIn,
          rttMs: client.rttMs,
          reconnects: client.reconnects,
          stale: now - client.lastSeenAt > staleAfter,
        })
      ),
      samplesSent: this.samplesSent,
      lastError: this.lastError,
      latestSample: this.latest,
      diagnostics: {
        startedAt: this.startedAt,
        uptimeSec: this.startedAt ? Math.round((now - this.startedAt) / 1000) : 0,
        intervalMs: this.config.intervalMs,
        samplesSent: this.samplesSent,
        lastSampleAt: this.lastSampleAt,
        sessions: this.sessions,
        reconnects: this.reconnectTotal,
        closedByServer: this.closedByServer,
        lastError: this.lastError,
      },
    };
  }

  getLatestSample(): ResourceUpdateMessage | null {
    return this.latest;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private newClientData(): ClientData {
    const now = Date.now();
    return {
      id: randomId("c"),
      remoteAddress: "lan",
      connectedAt: now,
      lastSeenAt: now,
      helloAt: null,
      configAcked: false,
      sentCount: 0,
      messagesIn: 0,
      rttMs: null,
      reconnects: 0,
    };
  }

  private restartTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs);
    console.log(`[monitor] tick timer set to ${this.config.intervalMs}ms`);
  }

  private startHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      let bufferInfo = "";
      for (const [ws, client] of this.clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;

        if (client.helloAt === null && now - client.connectedAt > HANDSHAKE_TIMEOUT_MS) {
          this.closeForDiagnostics(ws, client, "handshake timeout");
          continue;
        }
        if (now - client.lastSeenAt > SILENCE_TIMEOUT_MS) {
          this.closeForDiagnostics(ws, client, "silence timeout");
          continue;
        }

        const id = randomId("hb");
        this.pingSentAt.set(id, now);
        if (this.pingSentAt.size > 512) {
          const cutoff = now - 60000;
          for (const [key, sentAt] of this.pingSentAt) {
            if (sentAt < cutoff) this.pingSentAt.delete(key);
          }
        }
        this.send(ws, { type: "ping", proto: PROTOCOL_VERSION, ts: now, id, data: {} });
        bufferInfo += ` buf=${ws.getBufferedAmount()}`;
      }
      console.log(
        `[monitor] heartbeat: clients=${this.clients.size} samples=${this.samplesSent} ` +
          `ticks=${this.tickCount} idle=${this.tickIdle} interval=${this.config.intervalMs}${bufferInfo}`
      );
    }, HEARTBEAT_INTERVAL_MS);
  }

  private closeForDiagnostics(ws: ServerWebSocket<ClientData>, client: ClientData, reason: string) {
    this.closedByServer++;
    this.lastError = `${client.id} closed: ${reason}`;
    console.warn(`[monitor] closing ${client.id}: ${reason}`);
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  private async tick() {
    this.tickCount++;
    if (this.clients.size === 0) {
      this.tickIdle++;
      return;
    }
    if (this.collecting) {
      if (Date.now() - this.collectStartAt > 6000) {
        console.warn("[monitor] collector stuck >6s, resetting");
        this.collecting = false;
      } else {
        return;
      }
    }
    this.collecting = true;
    this.collectStartAt = Date.now();
    try {
      const data = await collectMetrics();
      const update = this.buildUpdate(data);
      for (const ws of this.clients.keys()) {
        if (ws.readyState === WebSocket.OPEN) this.send(ws, update);
      }
      this.latest = update;
      this.samplesSent += 1;
      this.lastSampleAt = Date.now();
    } catch (error) {
      this.lastError = `sample failed: ${String(error)}`;
    } finally {
      this.collecting = false;
    }
  }

  private buildUpdate(data: ResourceUpdateMessage["data"]): ResourceUpdateMessage {
    const message: ResourceUpdateMessage = {
      type: "resource_update",
      proto: PROTOCOL_VERSION,
      ts: Date.now(),
      data,
    };

    const overBudget = () => JSON.stringify(message).length > MAX_MESSAGE_BYTES;
    let trimmed = false;

    if (overBudget() && message.data.cpu?.cores) {
      delete message.data.cpu.cores;
      trimmed = true;
    }
    if (overBudget() && message.data.temperature?.extras) {
      delete message.data.temperature.extras;
      if (Object.keys(message.data.temperature).length === 0) delete message.data.temperature;
      trimmed = true;
    }
    if (overBudget() && message.data.fans?.entries && message.data.fans.entries.length > 2) {
      message.data.fans.entries = message.data.fans.entries.slice(0, 2);
      trimmed = true;
    }
    if (overBudget() && message.data.fans) {
      delete message.data.fans;
      trimmed = true;
    }
    if (overBudget() && message.data.temperature) {
      delete message.data.temperature;
      trimmed = true;
    }

    if (trimmed && Date.now() - this.lastTrimWarnAt > 30000) {
      this.lastTrimWarnAt = Date.now();
      console.warn(`[monitor] sample trimmed to fit ${MAX_MESSAGE_BYTES} byte budget`);
    }

    return message;
  }

  private async handleMessage(ws: ServerWebSocket<ClientData>, raw: string | Buffer) {
    const client = this.clients.get(ws);
    if (!client) return;
    client.lastSeenAt = Date.now();
    client.messagesIn++;

    let parsed: any;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      parsed = JSON.parse(text);
    } catch {
      this.sendError(ws, undefined, "INVALID_PAYLOAD", "frame is not valid JSON");
      return;
    }

    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      this.sendError(ws, parsed?.id, "INVALID_PAYLOAD", "message must be a JSON object with a type");
      return;
    }

    if (parsed.proto !== PROTOCOL_VERSION) {
      console.warn(`[monitor] closing ${client.id}: proto ${parsed.proto} != ${PROTOCOL_VERSION}`);
      this.sendError(ws, parsed.id, "UNSUPPORTED_VERSION", `expected proto ${PROTOCOL_VERSION}`);
      ws.close();
      return;
    }

    switch (parsed.type) {
      case "hello":
        this.handleHello(ws, client, parsed as HelloMessage);
        break;
      case "ack":
        this.handleAck(client, parsed as AckMessage);
        break;
      case "ping":
        this.handlePing(ws, parsed as PingMessage);
        break;
      case "pong": {
        const sentAt = typeof parsed.id === "string" ? this.pingSentAt.get(parsed.id) : undefined;
        if (sentAt !== undefined) {
          client.rttMs = Date.now() - sentAt;
          this.pingSentAt.delete(parsed.id);
        }
        break;
      }
      case "error":
        this.lastError = `device error: ${parsed?.data?.code ?? "UNKNOWN"}`;
        break;
      default:
        this.sendError(ws, parsed.id, "UNSUPPORTED_TYPE", `unknown type ${parsed.type}`);
    }
  }

  private handleHello(ws: ServerWebSocket<ClientData>, client: ClientData, hello: HelloMessage) {
    client.deviceId = hello.data?.deviceId;
    client.firmware = hello.data?.firmware;
    client.board = hello.data?.board;
    client.timezone = hello.data?.timezone;
    client.sessionId = randomId("s");
    client.configAcked = false;
    client.helloAt = Date.now();

    this.sessions++;
    if (client.deviceId) {
      const count = (this.sessionCounts.get(client.deviceId) ?? 0) + 1;
      this.sessionCounts.set(client.deviceId, count);
      client.reconnects = count - 1;
      if (count > 1) this.reconnectTotal++;
    }

    const welcome: WelcomeMessage = {
      type: "welcome",
      proto: PROTOCOL_VERSION,
      ts: Date.now(),
      data: {
        sessionId: client.sessionId,
        host: os.hostname(),
        intervalMs: this.config.intervalMs,
        serverVersion: SERVER_VERSION,
      },
    };
    this.send(ws, welcome);
    this.sendConfig(ws);
  }

  private handleAck(client: ClientData, ack: AckMessage) {
    if (ack.id?.startsWith("cfg")) client.configAcked = ack.data?.ok ?? false;
  }

  private handlePing(ws: ServerWebSocket<ClientData>, ping: PingMessage) {
    const pong: PongMessage = {
      type: "pong",
      proto: PROTOCOL_VERSION,
      ts: Date.now(),
      id: ping.id,
      data: {},
    };
    this.send(ws, pong);
  }

  private sendConfig(ws: ServerWebSocket<ClientData>) {
    const message: ConfigMessage = {
      type: "config",
      proto: PROTOCOL_VERSION,
      ts: Date.now(),
      id: randomId("cfg"),
      data: {
        screens: this.config.screens,
        rotateMs: this.config.rotateMs,
        brightness: this.config.brightness,
        timezone: this.config.timezone,
      },
    };
    this.send(ws, message);
  }

  private sendError(ws: ServerWebSocket<ClientData>, id: string | undefined, code: ErrorMessage["data"]["code"], message: string) {
    const error: ErrorMessage = {
      type: "error",
      proto: PROTOCOL_VERSION,
      ts: Date.now(),
      id,
      data: { code, message },
    };
    this.send(ws, error);
  }

  private send(ws: ServerWebSocket<ClientData>, message: { proto: number; ts: number; type: string; data: unknown; id?: string }) {
    if (ws.readyState !== WebSocket.OPEN) return;

    const buffered = ws.getBufferedAmount();
    if (buffered > MAX_BUFFERED_BYTES) {
      console.warn(`[monitor] client stalled (buffered=${buffered}), closing to force reconnect`);
      this.lastError = `client stalled (buffered=${buffered}), forced reconnect`;
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }

    try {
      ws.send(JSON.stringify(message));
      const data = ws.data;
      if (data && data.sentCount < 15) {
        console.log(`[monitor] → ${message.type} to ${data.id} (buf=${ws.getBufferedAmount()})`);
      }
      if (data) data.sentCount++;
    } catch (error) {
      this.lastError = `send failed: ${String(error)}`;
      console.warn(`[monitor] send ${message.type} failed: ${String(error)}`);
    }
  }
}
