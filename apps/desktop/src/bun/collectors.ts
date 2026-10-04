// v1.1 metric collectors: GPU (nvidia-smi), temperatures/fans (lm-sensors),
// and network counters (/proc/net/dev).
//
// Subprocess collectors are rate limited with a TTL cache and a failure
// backoff so a machine without nvidia-smi/lm-sensors pays no recurring cost.

import { readFileSync } from "node:fs";

const COLLECTOR_TTL_MS = 5000;
const FAILURE_BACKOFF_MS = 60_000;
const SPAWN_TIMEOUT_MS = 2500;
const MIB = 1024 * 1024;

export interface GpuSample {
  usage: number;
  vramUsed: number;
  vramTotal: number;
  tempC: number | null;
}

export interface TempReading {
  label: string;
  tempC: number;
}

export interface FanReading {
  label: string;
  rpm: number;
  percent: number | null;
}

export interface SensorSample {
  cpuTempC: number | null;
  systemTempC: number | null;
  gpuTempC: number | null;
  extras: TempReading[];
  fans: FanReading[];
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

async function run(cmd: string[], timeoutMs = SPAWN_TIMEOUT_MS): Promise<string | null> {
  try {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, timeoutMs);
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

export function parseNvidiaSmi(stdout: string): GpuSample | null {
  const line = stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;

  const parts = line.split(",").map((p) => p.trim());
  if (parts.length < 5) return null;

  const usage = Number(parts[1]);
  const usedMiB = Number(parts[2]);
  const totalMiB = Number(parts[3]);
  const temp = Number(parts[4]);
  if (!Number.isFinite(usage)) return null;

  return {
    usage: clampPercent(usage),
    vramUsed: Number.isFinite(usedMiB) ? Math.round(usedMiB * MIB) : 0,
    vramTotal: Number.isFinite(totalMiB) ? Math.round(totalMiB * MIB) : 0,
    tempC: Number.isFinite(temp) && temp > 0 ? round1(temp) : null,
  };
}

function chipBaseName(chip: string): string {
  return chip.replace(/-(isa|pci|usb|platform)-[0-9a-f]+$/i, "");
}

function prettyChip(chip: string): string {
  const base = chipBaseName(chip).toLowerCase();
  if (base.startsWith("nvme")) return "NVMe";
  if (base === "acpitz") return "ACPI";
  if (base.startsWith("iwlwifi") || base.startsWith("ath10k")) return "WiFi";
  if (base.startsWith("amdgpu") || base.startsWith("radeon")) return "GPU";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

interface RawTemp {
  chip: string;
  feature: string;
  tempC: number;
}

interface RawFan {
  chip: string;
  index: string;
  rpm: number;
  pwm: number | null;
}

const CPU_CHIP = /coretemp|k10temp|zenpower|cpu-thermal|soc_dts/i;
const GPU_CHIP = /amdgpu|nouveau|nvidia|radeon/i;
const BOARD_CHIP = /it87|nct\d|w83|f718|f71|fintek|acpitz|thinkpad|asus|via_temp/i;
const BOARD_FEATURE = /systin|system|motherboard|board|chipset|auxtin/i;

export function parseSensorsJson(json: string): SensorSample | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;

  const temps: RawTemp[] = [];
  const fans: RawFan[] = [];

  for (const [chip, value] of Object.entries(doc)) {
    if (!value || typeof value !== "object") continue;
    const features = value as Record<string, unknown>;

    for (const [key, raw] of Object.entries(features)) {
      if (typeof raw !== "number") continue;
      if (/^fan\d+_input$/.test(key)) {
        fans.push({ chip, index: key.match(/^fan(\d+)/)?.[1] ?? "1", rpm: Math.round(raw), pwm: null });
      } else if (/^pwm\d+$/.test(key)) {
        const index = key.match(/^pwm(\d+)/)?.[1];
        const existing = fans.find((f) => f.chip === chip && f.index === index);
        if (existing) existing.pwm = raw;
      } else if (/^temp\d+_input$/.test(key)) {
        temps.push({ chip, feature: key.replace("_input", ""), tempC: raw });
      }
    }

    for (const [group, raw] of Object.entries(features)) {
      if (!raw || typeof raw !== "object") continue;
      for (const [key, raw2] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof raw2 !== "number") continue;
        if (/^temp\d+_input$/.test(key)) {
          temps.push({ chip, feature: group, tempC: raw2 });
        } else if (/^fan\d+_input$/.test(key)) {
          fans.push({ chip, index: key.match(/^fan(\d+)/)?.[1] ?? "1", rpm: Math.round(raw2), pwm: null });
        }
      }
    }
  }

  const plausible = temps.filter((t) => t.tempC > -50 && t.tempC < 150);
  const pick = (candidates: RawTemp[], preferred: RegExp): RawTemp | null => {
    if (candidates.length === 0) return null;
    return candidates.find((c) => preferred.test(c.feature)) ?? candidates[0];
  };

  const cpuTemps = plausible.filter((t) => CPU_CHIP.test(chipBaseName(t.chip)));
  const gpuTemps = plausible.filter((t) => GPU_CHIP.test(chipBaseName(t.chip)));
  const boardTemps = plausible.filter(
    (t) => BOARD_CHIP.test(chipBaseName(t.chip)) || BOARD_FEATURE.test(t.feature)
  );

  const cpu = pick(cpuTemps, /package|tctl|tdie/i);
  const board = pick(boardTemps, /systin|system|motherboard|board/i);
  const gpu = pick(gpuTemps, /edge|gpu|junction|temp1/i);

  const usedChips = new Set<string>();
  for (const chosen of [cpu, board, gpu]) {
    if (chosen) usedChips.add(chosen.chip);
  }

  const byChip = new Map<string, RawTemp[]>();
  for (const temp of plausible) {
    const base = chipBaseName(temp.chip);
    if (usedChips.has(temp.chip) || CPU_CHIP.test(base) || GPU_CHIP.test(base)) continue;
    const list = byChip.get(temp.chip);
    if (list) list.push(temp);
    else byChip.set(temp.chip, [temp]);
  }

  const extras: TempReading[] = [];
  const labelCounts = new Map<string, number>();
  for (const [chip, readings] of byChip) {
    if (extras.length >= 4) break;
    const primary = readings.find((r) => /composite|package|tctl/i.test(r.feature)) ?? readings[0];
    let label = prettyChip(chip);
    const seen = (labelCounts.get(label) ?? 0) + 1;
    labelCounts.set(label, seen);
    if (seen > 1) label = `${label} ${seen}`;
    extras.push({ label, tempC: round1(primary.tempC) });
  }

  const fanReadings: FanReading[] = [];
  for (const fan of fans) {
    if (fanReadings.length >= 6 || fan.rpm < 0 || fan.rpm > 30000) continue;
    fanReadings.push({
      label: `${prettyChip(fan.chip)} FAN${fan.index}`,
      rpm: fan.rpm,
      percent:
        fan.pwm !== null && fan.pwm >= 0 && fan.pwm <= 255
          ? Math.round((fan.pwm / 255) * 100)
          : null,
    });
  }

  return {
    cpuTempC: cpu ? round1(cpu.tempC) : null,
    systemTempC: board ? round1(board.tempC) : null,
    gpuTempC: gpu ? round1(gpu.tempC) : null,
    extras,
    fans: fanReadings,
  };
}

export function readNetCounters(): { rx: number; tx: number } | null {
  try {
    const content = readFileSync("/proc/net/dev", "utf8");
    let rx = 0;
    let tx = 0;
    for (const line of content.split("\n").slice(2)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const iface = line.slice(0, colon).trim();
      if (iface === "lo") continue;
      const fields = line.slice(colon + 1).trim().split(/\s+/);
      const rxBytes = Number(fields[0]);
      const txBytes = Number(fields[8]);
      if (Number.isFinite(rxBytes)) rx += rxBytes;
      if (Number.isFinite(txBytes)) tx += txBytes;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

let gpuCache: { at: number; value: GpuSample | null } = { at: 0, value: null };
let gpuBackoffUntil = 0;
let sensorCache: { at: number; value: SensorSample | null } = { at: 0, value: null };
let sensorBackoffUntil = 0;

async function collectGpuOnce(): Promise<GpuSample | null> {
  const out = await run([
    "nvidia-smi",
    "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
    "--format=csv,noheader,nounits",
  ]);
  if (!out) return null;
  return parseNvidiaSmi(out);
}

async function collectSensorsOnce(): Promise<SensorSample | null> {
  const out = await run(["sensors", "-j"]);
  if (out) return parseSensorsJson(out);

  try {
    const si = await import("systeminformation");
    const data = await si.cpuTemperature();
    const cpu = Number(data?.main);
    if (Number.isFinite(cpu) && cpu > 0) {
      return { cpuTempC: round1(cpu), systemTempC: null, gpuTempC: null, extras: [], fans: [] };
    }
  } catch {}
  return null;
}

export async function collectGpu(): Promise<GpuSample | null> {
  const now = Date.now();
  if (now < gpuBackoffUntil) return null;
  if (now - gpuCache.at < COLLECTOR_TTL_MS) return gpuCache.value;

  const sample = await collectGpuOnce();
  gpuCache = { at: now, value: sample };
  if (!sample) gpuBackoffUntil = now + FAILURE_BACKOFF_MS;
  return sample;
}

export async function collectSensors(): Promise<SensorSample | null> {
  const now = Date.now();
  if (now < sensorBackoffUntil) return null;
  if (now - sensorCache.at < COLLECTOR_TTL_MS) return sensorCache.value;

  const sample = await collectSensorsOnce();
  sensorCache = { at: now, value: sample };
  if (!sample) sensorBackoffUntil = now + FAILURE_BACKOFF_MS;
  return sample;
}
