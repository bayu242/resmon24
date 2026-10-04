// RPC bridge — calls Bun via Electrobun RPC, falls back to mock data in browser dev mode.

import type { ResourceUpdateMessage } from "@resmon24/protocol";
import type { MonitorState, SetMonitorConfigParams } from "../../stubs/types";

function getRpc() {
  return (window as any).__monitorRpc ?? null;
}

function mockState(): MonitorState {
  return {
    running: false,
    hostname: "0.0.0.0",
    port: 8765,
    startedAt: null,
    config: {
      intervalMs: 1000,
      screens: ["cpu", "memory", "clock"],
      rotateMs: 5000,
      brightness: 200,
    },
    clients: [],
    samplesSent: 0,
    lastError: null,
    latestSample: null,
    diagnostics: {
      startedAt: null,
      uptimeSec: 0,
      intervalMs: 1000,
      samplesSent: 0,
      lastSampleAt: null,
      sessions: 0,
      reconnects: 0,
      closedByServer: 0,
      lastError: null,
    },
  };
}

export async function getMonitorState(): Promise<MonitorState> {
  const rpc = getRpc();
  if (rpc) return rpc.request.get_monitor_state({});
  await new Promise((r) => setTimeout(r, 150));
  return mockState();
}

export async function getLatestSample(): Promise<ResourceUpdateMessage | null> {
  const rpc = getRpc();
  if (rpc) return rpc.request.get_latest_sample({});
  await new Promise((r) => setTimeout(r, 150));
  return null;
}

export async function setMonitorConfig(params: SetMonitorConfigParams): Promise<MonitorState> {
  const rpc = getRpc();
  if (rpc) return rpc.request.set_monitor_config(params);
  await new Promise((r) => setTimeout(r, 150));
  const state = mockState();
  state.config = { ...state.config, ...params, screens: params.screens ?? state.config.screens };
  return state;
}

export async function startMonitor(): Promise<MonitorState> {
  const rpc = getRpc();
  if (rpc) return rpc.request.start_monitor({});
  await new Promise((r) => setTimeout(r, 150));
  return mockState();
}

export async function stopMonitor(): Promise<MonitorState> {
  const rpc = getRpc();
  if (rpc) return rpc.request.stop_monitor({});
  await new Promise((r) => setTimeout(r, 150));
  return mockState();
}
