// resmon24 metrics collector.
//
// Uses Node's native `os` module for CPU/memory (zero child processes) so
// sampling can never hang: CPU utilization is computed from deltas between
// successive samples. GPU and temperature/fan collection shell out to
// nvidia-smi and lm-sensors on a TTL cache (see collectors.ts); network
// throughput is read from /proc/net/dev.

import os from "node:os";
import type { ResourceUpdateMessageData } from "@resmon24/protocol";
import { collectGpu, collectSensors, readNetCounters } from "./collectors";

let previousCpus: os.CpuInfo[] | null = null;
let previousNet: { at: number; rx: number; tx: number } | null = null;

function clamp1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function cpuSnapshot(): { usage: number; cores: number[] } | null {
  const cpus = os.cpus();
  if (!previousCpus || previousCpus.length !== cpus.length) {
    previousCpus = cpus;
    return null; // first sample only primes the delta
  }

  const cores: number[] = [];
  let busyTotal = 0;
  let deltaTotal = 0;

  for (let i = 0; i < cpus.length; i++) {
    const prev = previousCpus[i].times;
    const cur = cpus[i].times;
    const busy =
      cur.user - prev.user +
      (cur.nice - prev.nice) +
      (cur.sys - prev.sys) +
      (cur.irq - prev.irq);
    const idle = cur.idle - prev.idle;
    const total = busy + idle;
    cores.push(clamp1(total > 0 ? (busy / total) * 100 : 0));
    busyTotal += busy;
    deltaTotal += total;
  }

  previousCpus = cpus;
  return {
    usage: clamp1(deltaTotal > 0 ? (busyTotal / deltaTotal) * 100 : 0),
    cores,
  };
}

function networkRates(): { rxBytesPerSec: number; txBytesPerSec: number } | null {
  const counters = readNetCounters();
  if (!counters) return null;

  const now = Date.now();
  const previous = previousNet;
  previousNet = { at: now, ...counters };
  if (!previous || now <= previous.at) return null;

  const seconds = (now - previous.at) / 1000;
  const rx = (counters.rx - previous.rx) / seconds;
  const tx = (counters.tx - previous.tx) / seconds;
  if (!Number.isFinite(rx) || !Number.isFinite(tx) || rx < 0 || tx < 0) return null;

  return { rxBytesPerSec: Math.round(rx), txBytesPerSec: Math.round(tx) };
}

export async function collectMetrics(): Promise<ResourceUpdateMessageData> {
  const data: ResourceUpdateMessageData = {};

  const cpu = cpuSnapshot();
  if (cpu) {
    data.cpu = { usage: cpu.usage, cores: cpu.cores };
  }

  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  data.memory = {
    used,
    total,
    percent: total > 0 ? clamp1((used / total) * 100) : 0,
  };

  const network = networkRates();
  if (network) data.network = network;

  const [gpu, sensors] = await Promise.all([collectGpu(), collectSensors()]);

  if (gpu) {
    data.gpu = {
      usage: gpu.usage,
      vramUsed: gpu.vramUsed,
      vramTotal: gpu.vramTotal,
      tempC: gpu.tempC,
    };
  }

  if (sensors) {
    const extras = [...sensors.extras];
    if (sensors.gpuTempC !== null && !gpu) {
      extras.unshift({ label: "GPU", tempC: sensors.gpuTempC });
    }

    const temperature: NonNullable<ResourceUpdateMessageData["temperature"]> = {};
    if (sensors.systemTempC !== null) temperature.system = sensors.systemTempC;
    if (extras.length > 0) temperature.extras = extras.slice(0, 4);
    if (Object.keys(temperature).length > 0) data.temperature = temperature;

    if (sensors.fans.length > 0) data.fans = { entries: sensors.fans };

    if (data.cpu && sensors.cpuTempC !== null) {
      data.cpu.tempC = sensors.cpuTempC;
    }
  }

  data.uptimeSec = Math.round(os.uptime());

  return data;
}
