# Development Guide

How to set up, build, test, and contribute to `resmon24`. For system design see [`architecture.md`](./architecture.md); for the wire contract see [`protocol.md`](./protocol.md).

## 1. Prerequisites

### Desktop (`apps/desktop`)

| Tool | Version | Notes |
|---|---|---|
| Bun | ≥ 1.1 | Desktop runtime + package manager (Electrobun) |
| Node.js | ≥ 20 LTS | For protocol codegen and shared tooling |
| Linux | x86_64 | Desktop target is Linux only in the MVP |

Optional for GPU/temperature metrics — the v1.1 collectors degrade gracefully
(group omitted) when these are missing:
- NVIDIA driver + `nvidia-smi` on `PATH`
- `lm-sensors` (`sensors`)

### Firmware (`apps/firmware`)

| Tool | Version | Notes |
|---|---|---|
| PlatformIO Core | ≥ 6 | Or the VS Code PlatformIO extension |
| Python | 3.8+ | Pulled in by PlatformIO |
| Hardware | ESP8266 d1_mini + SSD1306 128×64 (I2C `0x3C`) | USB cable for flashing |

### Protocol (`packages/protocol`, `scripts/`)

- Node.js ≥ 20 (generation scripts run on the desktop toolchain)
- A JSON Schema generation library (chosen by the generator implementation — TBD)

## 2. Repository Setup

```bash
git clone <repo-url> resmon24
cd resmon24
```

The project is a multi-app repo. Dependencies are installed per app, not at the root (until a workspace is introduced — see §8).

```bash
# desktop
cd apps/desktop && bun install

# firmware
cd apps/firmware && pio pkg install
```

## 3. Building & Running

### 3.1 Desktop application

```bash
cd apps/desktop
bun run dev        # Vite HMR + Electrobun dev (watches src/bun/)
bun run build      # vite build && electrobun build
```

The desktop starts a WebSocket server (port `8765`), advertises over mDNS, and
streams metrics. CPU/RAM are sampled from `os`; GPU (`nvidia-smi`),
temperatures/fans (`sensors`, lm-sensors), and network rates (`/proc/net/dev`)
are collected on a TTL cache with failure backoff, so missing tools degrade to
omitted groups instead of errors. The last applied display configuration is
persisted at `$XDG_CONFIG_HOME/resmon24/config.json` (default
`~/.config/resmon24/config.json`) and restored on the next launch.

### 3.2 Firmware (ESP8266)

```bash
cd apps/firmware

pio run                     # compile
pio run --target upload     # flash over USB
pio device monitor          # serial console @ 115200
```

Board and libraries are declared in `apps/firmware/platformio.ini`:

```ini
[env:esp8266]
platform = espressif8266
board = d1_mini
framework = arduino
board_build.filesystem = littlefs
monitor_speed = 115200
upload_speed = 921600

build_flags =
    -I${PROJECT_DIR}/../../packages/protocol/generated/cpp

lib_deps =
    bblanchon/ArduinoJson @ ^7.0.0
    links2004/WebSockets @ ^2.4.0
    adafruit/Adafruit GFX Library @ ^1.11.0
    adafruit/Adafruit SSD1306 @ ^2.5.0
```

> `ESP8266WebServer` and `DNSServer` (used by the custom WiFi manager) ship with the ESP8266 Arduino core, so they are **not** listed in `lib_deps`. The previous `tzapu/WiFiManager` dependency has been removed in favor of the first-party portal.

### 3.3 First-boot onboarding (custom WiFi manager)

1. Power the board. With no stored configuration it broadcasts `Resmon24-Setup` within ~15 s.
2. Connect to that AP from a phone/laptop; the OLED shows the AP SSID and portal IP (`192.168.4.1`).
3. The captive portal serves a single form:
   - **WiFi SSID**
   - **WiFi password**
   - **Timezone** — dropdown of common POSIX TZ values (UTC, WIB-7, WITA-8, WIT-9, SGT-8, JST-9, IST, US/EU options)
4. On submit the device validates, writes `ssid`, `password`, and `timezone` to `/wifi.json` on LittleFS, and joins the network.
5. On success the OLED enters **CLOCK mode** (time + date + WiFi/IP) while waiting for the desktop session. It switches to **RESOURCE mode** automatically once the desktop connects.

If the portal rejects a value, it re-renders the form with an inline error; nothing is saved until all fields are valid. There is no manual IP/port entry — the device finds the desktop over mDNS (`_resmon24._tcp`) and re-queries every 5 s until it succeeds.

To reset credentials and timezone, erase flash: `pio run --target erase` (or `pio run --target uploadfs` to wipe LittleFS).

### 3.4 Packaging (Linux)

```bash
cd apps/desktop
bun run package:linux          # vite build + electrobun build --env=stable, then package
bun run package:linux:quick    # package the existing build/ output without rebuilding
```

Both artifacts are written to `apps/desktop/artifacts/` alongside Electrobun's own
release files (`*.tar.zst`, update manifest), plus a `SHA256SUMS`:

| Artifact | Example |
|---|---|
| Debian package | `resmon24_1.0.0_amd64.deb` |
| AppImage | `Resmon24-1.0.0-x86_64.AppImage` |

Shared layout: payload in `/opt/resmon24`, a `/usr/bin/resmon24` wrapper that
resolves the app directory relative to itself (so the same wrapper works inside
an AppImage), `usr/share/applications/resmon24.desktop`, and a 256×256 icon.

Tooling the script expects: `dpkg-deb` (≥ 1.20 for `--root-owner-group`),
`mksquashfs` with zstd, `curl` (fetches the AppImage type2 runtime once into
`build/tools/`), and Python 3 + Pillow for the icon (packaging continues without
it). Install with `sudo dpkg -i artifacts/resmon24_<version>_amd64.deb`; run the
AppImage directly or double-click it.

## 4. Display Modes (firmware)

The firmware implements the state machine described in [`architecture.md` §5](./architecture.md#5-display-mode-state-machine):

| Mode | When | Shows |
|---|---|---|
| `SETUP` | No config / repeated join failures | AP SSID + portal IP |
| `CONNECTING` | WiFi join in progress | Attempt/progress |
| `CLOCK` | WiFi up, no live desktop session | Time + date + WiFi/IP |
| `RESOURCE` | `welcome` received / metrics arriving | Configured resource screens |

Test transitions by stopping/starting the desktop (or unplugging the network) and watching the OLED plus serial log — no reboot should be required.

## 5. Protocol Code Generation

Schemas in `packages/protocol/schema/` are the source of truth.

```bash
# from repo root (script location/name TBD)
node scripts/generate-protocol.mjs
```

This writes:
- `packages/protocol/generated/typescript/`
- `packages/protocol/generated/cpp/`

Rules:
- **Never edit generated files by hand.** They carry a machine-generated header.
- Commit schema changes and regenerated output together.
- CI runs generation and fails if the working tree is dirty (drift gate).

## 6. Testing

| Layer | Command | What it covers |
|---|---|---|
| Protocol codegen | `node scripts/generate-protocol.mjs --check` in CI | Generated output matches schema |
| Desktop smoke | `bun scripts/monitor-smoke.ts` | Device handshake, heartbeat, size budget |
| Desktop v1.1 smoke | `bun scripts/v11-smoke.ts` | Session flow, diagnostics, RTT, reconnect accounting, config push, persisted config store |
| Desktop KPI #6 | `bun scripts/kpi6-check.ts` | CPU/RSS while streaming to a fake device (gate: < 2% CPU, < 150 MB RSS) |
| Desktop | `bun test` (planned) | Collector normalization, reconnect backoff, size budget |
| Firmware (native) | `pio test -e native` (where feasible) | Parser + `ScreenManager` + `SessionState` logic without hardware |
| Portal | `pio test -e native` | SSID required, POSIX TZ parsing, LittleFS persistence round-trip |
| Hardware smoke | manual / HIL, `pio run --target upload` + monitor | WiFi onboarding, portal form, WS connect, OLED render, mode switch |
| E2E soak | `scripts/soak-test.*` (planned) | 24 h stability, KPI #1/#2/#5/#7 |

Lint and typecheck before opening a PR:

```bash
cd apps/desktop && bunx tsc -p tsconfig.json
```

> If these script names differ in the actual `package.json`, update this document — do not guess on contributors' behalf.

## 7. Contributor Workflow

1. Create a branch from `main`.
2. Make changes; keep protocol changes schema-first.
3. Run lint, typecheck, unit tests, and codegen `--check`.
4. Open a PR with: summary, screenshots/serial logs for firmware changes, and any KPI-affecting measurements.
5. Firmware changes should include a serial capture demonstrating a clean boot and no watchdog resets.

### Adding a new metric (end to end)

1. Extend `packages/protocol/schema/resource_update.schema.json`.
2. Run codegen; commit generated TS/C++.
3. Collect the metric on the desktop (detect capability; skip gracefully).
4. Render it on the device (add/extend a screen in `ScreenManager`).
5. Add fixture vectors (valid + invalid) to the shared conformance tests.
6. Update [`protocol.md`](./protocol.md) and the relevant PRD rows.

### Adding a new metric screen (firmware + desktop)

Screen ids are free-form: a single metric (`cpu`, `memory`, …) or a `+`-separated
composite (`cpu+memory+gpu+network`) that packs several metrics into one frame.

1. Add the token to `METRIC_TOKENS` in `apps/desktop/src/stubs/screens.ts` and mention it in the `screens` item description in `config.schema.json`, then regenerate.
2. Teach `ScreenManager::parseScreenId` the new token (and a short alias if useful).
3. Add a row builder in `renderComposite`; add a full-screen `show…Screen` in `OledDisplay` if the metric deserves one.
4. Add a preset to `BASIC_SCREENS` if it should appear in the Basic section — the Custom picker is generated from `METRIC_TOKENS`.
5. Ensure it degrades on missing data, fits the 1 KB budget, and only shows in RESOURCE mode.
6. Add a golden framebuffer snapshot test where possible.

### Changing the onboarding form (firmware)

1. Update the portal handler in `NetworkManager` and the `/wifi.json` schema together.
2. Validate on the device before persisting; never trust the browser.
3. Add/extend a native test for the validator and a manual captive-portal test (Android + iOS).
4. Update [`PRD.md`](./PRD.md) US-1 and this guide.

## 8. Monorepo Conventions (target state)

- `packages/protocol` holds the JSON Schemas (source of truth) and the generated TypeScript/C++ types. `scripts/generate-protocol.mjs` is the generator.
- Consider a root workspace (`npm workspaces` or pnpm) to unify scripts and dependency installs.
- Shared scripts live in `scripts/` and must be runnable from the repo root.
- Firmware build artifacts (`.pio/`) are local only and must be gitignored.

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| OLED stays blank | Wrong I2C address or wiring | Confirm `0x3C`; check SDA/SCL; try `0x3D` |
| No `Resmon24-Setup` AP | Stored config present, or AP failed to start | Erase flash to force onboarding; check serial log |
| Captive portal doesn't open automatically | OS captive-portal detection quirk | Navigate to `192.168.4.1` manually |
| Portal rejects timezone | Not a valid POSIX TZ string | Use `UTC` or a value like `WIB-7`, `America/New_York` |
| Never leaves "Connecting to WiFi" | Bad credentials or router out of range | Re-enter via `Resmon24-Setup`; erase flash if stuck |
| Stuck in CLOCK mode | Desktop not running or not streaming | Start the desktop app; confirm WS session established |
| Clock wrong | NTP blocked or timezone mismatch | Check UDP 123 egress; verify TZ in the portal/desktop override |
| Desktop can't find device | mDNS blocked (VLAN/firewall) | Allow mDNS (UDP 5353) on the LAN; put both hosts on the same broadcast domain |
| Random ESP resets | Heap exhaustion / oversized JSON | Check `ESP.getFreeHeap()`; enforce the 1 KB message budget |
| `pio` upload fails | Missing USB permissions | Add udev rule for the CP210x/CH340 serial adapter |

## 10. Related Documents

- [`PRD.md`](./PRD.md) — requirements and success criteria
- [`architecture.md`](./architecture.md) — components and data flow
- [`protocol.md`](./protocol.md) — message schemas and reliability rules
- [`roadmap.md`](./roadmap.md) — what ships when
