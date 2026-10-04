// Last-applied display configuration, persisted as JSON in the app config
// dir so the desktop restores the user's settings after a restart.
//
// Electrobun has no electron-store equivalent, so the config lives next to the
// other user state: $XDG_CONFIG_HOME/resmon24/config.json (default
// ~/.config/resmon24/config.json).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MonitorConfig } from "../stubs/types";
import { sanitizeScreens } from "../stubs/screens";

const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 10000;
const MIN_ROTATE_MS = 2000;
const MAX_ROTATE_MS = 60000;

interface StoreFile {
  version: 1;
  config: MonitorConfig;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "resmon24", "config.json");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sanitizeConfig(config: MonitorConfig): MonitorConfig {
  const screens = sanitizeScreens(Array.isArray(config.screens) ? config.screens : []);
  const next: MonitorConfig = {
    intervalMs: clamp(Number(config.intervalMs) || 1000, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
    screens: screens.length > 0 ? screens : ["clock"],
    rotateMs: clamp(Number(config.rotateMs) || 5000, MIN_ROTATE_MS, MAX_ROTATE_MS),
  };
  if (typeof config.brightness === "number") {
    next.brightness = clamp(config.brightness, 0, 255);
  }
  if (typeof config.timezone === "string" && config.timezone.length > 0) {
    next.timezone = config.timezone;
  }
  return next;
}

export function loadConfig(): MonitorConfig | null {
  try {
    if (!existsSync(configPath())) return null;
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.config) return null;
    if (!Array.isArray(parsed.config.screens)) return null;
    return sanitizeConfig(parsed.config as MonitorConfig);
  } catch {
    return null;
  }
}

export function saveConfig(config: MonitorConfig): void {
  const path = configPath();
  const store: StoreFile = { version: 1, config: sanitizeConfig(config) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}
