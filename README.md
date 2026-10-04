# resmon24

**An open-source external hardware resource monitor for Linux.**
A desktop app samples CPU / RAM / GPU / temperature and streams the metrics over
the local network to a small ESP8266 + OLED device on your desk — glanceable
machine health without stealing a single pixel of screen real estate.

No cloud. No accounts. Just your machine, your LAN, and a tiny display.

---

## Why

- Fullscreen game, render, or headless SSH session? The dashboard on the
  monitored machine is exactly where you can't see it.
- resmon24 puts the numbers on a **dedicated physical display** that is always
  on, always visible, and never in your way.
- When the desktop is idle/locked, the device flips to a **clock + date** face —
  so it's never a dead panel.

## Features

- **Adaptive display** — CLOCK ⇄ RESOURCE mode switch within 1 s of desktop
  session changes, no blank frames.
- **Captive-portal onboarding** — first boot opens a WiFi portal; enter SSID,
  password, and timezone. No flashing to reconfigure.
- **mDNS discovery** — device finds the desktop automatically
  (`_resmon24._tcp.local`); no IPs to type.
- **Schema-first protocol** — JSON Schema is the single source of truth; TS and
  C++ types are generated from it, so desktop and firmware can never drift.
- **Lightweight by design** — target overhead is < 2% CPU and < 150 MB RSS on
  the desktop while streaming; p95 metric freshness ≤ 2 s at a 1 s push rate.
- **Adaptive screens** — CPU, memory (and GPU / temperature in v1.1) rendered on
  a 128×64 I2C OLED.

## How it works

```
┌──────────────────────────┐      WebSocket / JSON       ┌──────────────────────────┐
│      Linux Desktop       │  ────────────────────────►  │         ESP8266          │
│  Electrobun + React      │                            │  WiFi · WS client        │
│  CPU / RAM / GPU / Temp  │  ◄────────────────────────  │  Message parser          │
└──────────────────────────┘     hello / ack / error     └────────────┬─────────────┘
                                                                     │ I2C
                                                                     ▼
                                                                ┌─────────┐
                                                                │  OLED   │
                                                                │ 128×64  │
                                                                └─────────┘
```

1. The **desktop app** samples hardware metrics (via `systeminformation`) and
   serves them over a local WebSocket.
2. The **firmware** discovers the desktop via mDNS, connects, and parses the
   schema-defined JSON messages.
3. The **OLED** renders the live resource view — or a clock when no session is
   active.

## Repository layout

```
resmon24/
├── apps/
│   ├── desktop/        # Electrobun + React 19 + Tailwind v4 desktop app
│   └── firmware/       # ESP8266 (Wemos D1 mini) firmware — PlatformIO / Arduino
├── packages/
│   └── protocol/       # JSON Schemas (source of truth) + generated TS/C++ types
├── scripts/            # Protocol codegen and repo tooling
├── docs/               # PRD, architecture, protocol, development, roadmap
└── site/               # GitHub Pages landing page
```

| Package | Stack | Purpose |
|---|---|---|
| `apps/desktop` | Electrobun, Bun, React 19, TanStack Query, Tailwind v4, Vite 7 | Metric collection, WebSocket server, settings UI |
| `apps/firmware` | ESP8266 (d1_mini), ArduinoJson, WebSockets, Adafruit GFX/SSD1306 | WiFi onboarding, WS client, OLED rendering |
| `packages/protocol` | JSON Schema → TypeScript + C++ codegen | Wire contract shared by both ends |

## Getting started

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- [PlatformIO](https://platformio.org) (CLI or IDE) for firmware
- Linux desktop (packaged builds target Linux x64)
- Hardware: ESP8266 board (e.g. Wemos D1 mini) + SSD1306 128×64 I2C OLED

### Setup

```bash
# Desktop
cd apps/desktop
bun install
bun run dev          # Vite HMR + Electrobun dev

# Firmware
cd apps/firmware
pio pkg install
pio run              # compile
pio run --target upload
pio device monitor   # serial console @ 115200
```

First boot launches the **captive portal** — join the device's AP, enter WiFi
SSID / password / timezone, and it connects to your desktop automatically.

### Protocol codegen

```bash
cd packages/protocol
bun run generate     # regenerate TS + C++ types from schema
bun run check        # CI drift check (fails if generated output is stale)
```

### Packaging (Linux)

```bash
cd apps/desktop
bun run package:linux   # → .AppImage / .deb / .tar.zst in apps/desktop/artifacts/
```

### Tests

| Check | Command |
|---|---|
| Desktop smoke (handshake, heartbeat) | `cd apps/desktop && bun scripts/monitor-smoke.ts` |
| Desktop v1.1 smoke (session, RTT, config) | `cd apps/desktop && bun scripts/v11-smoke.ts` |
| Desktop KPI #6 (CPU/RSS budget) | `cd apps/desktop && bun scripts/kpi6-check.ts` |
| Protocol drift | `cd packages/protocol && bun run check` |
| Typecheck | `cd apps/desktop && bunx tsc -p tsconfig.json` |

## Documentation

| Document | Contents |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Problem, personas, user stories, KPIs |
| [docs/architecture.md](docs/architecture.md) | System context, components, data flow |
| [docs/protocol.md](docs/protocol.md) | Wire protocol and message contract |
| [docs/development.md](docs/development.md) | Setup, build, test, contributor workflow |
| [docs/roadmap.md](docs/roadmap.md) | MVP → v1.1 phases and exit criteria |

## Project status

Active development. MVP targets CPU + memory monitoring with captive-portal
onboarding and the adaptive CLOCK ⇄ RESOURCE display; v1.1 adds GPU,
temperature, fans, and screen rotation. See [docs/roadmap.md](docs/roadmap.md).

## License

[MIT](LICENSE) © 2026 Bayu Seto Aji
