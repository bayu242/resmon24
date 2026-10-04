// Screen id model shared by the desktop UI and the Bun monitor server.
//
// A screen id is one metric token or a "+"-separated composite that packs
// several metrics into a single OLED frame, e.g. "cpu+memory+gpu+network".
// The firmware parses the same grammar (see ScreenManager::parseScreenId).

export const METRIC_TOKENS = [
  "cpu",
  "memory",
  "gpu",
  "network",
  "sensors",
  "clock",
  "wifi",
] as const;

export type MetricToken = (typeof METRIC_TOKENS)[number];

export const MAX_SCREENS = 5;
export const MAX_SCREEN_ID_LEN = 39;

export const METRIC_LABELS: Record<MetricToken, string> = {
  cpu: "CPU",
  memory: "MEM",
  gpu: "GPU",
  network: "NET",
  sensors: "SENS",
  clock: "CLOCK",
  wifi: "WIFI",
};

// Basic screens: one metric per screen, toggled straight into the rotation.
export const BASIC_SCREENS: { id: string; label: string }[] = METRIC_TOKENS.map((token) => ({
  id: token,
  label: METRIC_LABELS[token],
}));

// Custom screen presets: several metrics packed into one frame.
export const COMBO_SCREENS: { id: string; label: string }[] = [
  { id: "cpu+memory+gpu+network", label: "CPU + MEM + GPU + NET" },
  { id: "cpu+memory+gpu", label: "CPU + MEM + GPU" },
  { id: "clock+cpu+memory+gpu", label: "CLOCK + CPU + MEM + GPU" },
  { id: "cpu+memory+network", label: "CPU + MEM + NET" },
  { id: "clock+network+sensors", label: "CLOCK + NET + SENSORS" },
  { id: "clock+sensors", label: "CLOCK + SENSORS" },
];

export function parseScreen(id: string): MetricToken[] {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_SCREEN_ID_LEN) return [];
  const tokens: MetricToken[] = [];
  for (const part of id.split("+")) {
    if (!(METRIC_TOKENS as readonly string[]).includes(part)) return [];
    tokens.push(part as MetricToken);
  }
  return tokens;
}

export function isValidScreen(id: string): boolean {
  return parseScreen(id).length > 0;
}

export function makeScreenId(tokens: MetricToken[]): string {
  return tokens.join("+");
}

export function screenLabel(id: string): string {
  const tokens = parseScreen(id);
  if (tokens.length === 0) return id;
  return tokens.map((token) => METRIC_LABELS[token]).join(" + ");
}

export function sanitizeScreens(screens: string[]): string[] {
  return Array.from(new Set(screens.filter(isValidScreen))).slice(0, MAX_SCREENS);
}
