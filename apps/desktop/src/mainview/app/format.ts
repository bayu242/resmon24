// Compact value formatting: adaptive decimals and unit scaling.

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function formatBytes(bytes?: number | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const decimals = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
}

export function formatBytesPair(used?: number | null, total?: number | null): string {
  if (used === undefined || total === undefined) return "—";
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}

export function formatRate(bytesPerSec?: number | null): string {
  if (typeof bytesPerSec !== "number" || !Number.isFinite(bytesPerSec)) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatPercent(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const clamped = Math.max(0, Math.min(100, value));
  const decimals = clamped >= 100 ? 0 : clamped >= 10 ? 1 : 2;
  return `${clamped.toFixed(decimals)}%`;
}

export function formatTemp(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const decimals = Math.abs(value) < 10 ? 1 : 0;
  return `${value.toFixed(decimals)}°C`;
}

export function formatRpm(rpm?: number | null): string {
  if (typeof rpm !== "number" || !Number.isFinite(rpm)) return "—";
  return `${Math.round(rpm).toLocaleString()} rpm`;
}

export function formatUptime(seconds?: number | null): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
}

export function formatAge(timestamp?: number | null, now = Date.now()): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const ms = Math.max(0, now - timestamp);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatDurationMs(ms?: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
