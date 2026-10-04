// Cross-process RPC type contracts for Resmon24.
//
// MonitorConfig / MonitorClient / MonitorState mirror the shapes produced by
// MonitorServer.getState() in src/bun/server.ts; MonitorRPC is the schema for
// the Bun <-> renderer bridge.

import type { ResourceUpdateMessage } from "@resmon24/protocol";

// ── Monitor domain ────────────────────────────────────────────────────────────

export type MonitorConfig = {
  intervalMs: number;
  screens: string[];
  rotateMs: number;
  brightness?: number;
  timezone?: string;
};

export type MonitorClient = {
  id: string;
  remoteAddress: string;
  deviceId?: string;
  firmware?: string;
  board?: string;
  timezone?: string;
  connectedAt: number;
  lastSeenAt: number;
  configAcked: boolean;
  messagesIn: number;
  rttMs: number | null;
  reconnects: number;
  stale: boolean;
};

export type MonitorDiagnostics = {
  startedAt: number | null;
  uptimeSec: number;
  intervalMs: number;
  samplesSent: number;
  lastSampleAt: number | null;
  sessions: number;
  reconnects: number;
  closedByServer: number;
  lastError: string | null;
};

export type MonitorState = {
  running: boolean;
  hostname: string;
  port: number;
  startedAt: number | null;
  config: MonitorConfig;
  clients: MonitorClient[];
  samplesSent: number;
  lastError: string | null;
  latestSample: ResourceUpdateMessage | null;
  diagnostics: MonitorDiagnostics;
};

export type SetMonitorConfigParams = {
  intervalMs?: number;
  screens?: string[];
  rotateMs?: number;
  brightness?: number;
  timezone?: string;
};

// ── Monitor RPC (Bun ↔ renderer) ─────────────────────────────────────────────

export type MonitorRPC = {
  webview: {
    requests: Record<never, never>
    messages: Record<never, never>
  }
  bun: {
    requests: {
      get_monitor_state:  { params: Record<never, never>; response: MonitorState }
      get_latest_sample:  { params: Record<never, never>; response: ResourceUpdateMessage | null }
      set_monitor_config: { params: SetMonitorConfigParams; response: MonitorState }
      start_monitor:      { params: Record<never, never>; response: MonitorState }
      stop_monitor:       { params: Record<never, never>; response: MonitorState }
    }
    messages: Record<never, never>
  }
}
