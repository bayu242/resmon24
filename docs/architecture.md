# Architecture

This document describes the system architecture of `resmon24`. Product requirements and scope live in [`PRD.md`](./PRD.md); the wire contract lives in [`protocol.md`](./protocol.md).

## 1. System Context

`resmon24` collects real-time hardware metrics on a Linux machine and displays them on an external ESP8266 + OLED device over the local network. There is no cloud component and no internet dependency except NTP for the clock. The device has two display personalities: a **clock/date** view when no desktop session is active, and a **resource monitor** view once the desktop connects. Onboarding is handled by a first-party captive portal that collects WiFi SSID, WiFi password, and timezone.

```
┌──────────────────────────┐        WebSocket / JSON        ┌──────────────────────────┐
│      Linux Desktop       │  ───────────────────────────►  │         ESP8266          │
│                          │                                │                          │
│  Electrobun + React       │  ◄───────────────────────────  │  WiFi                    │
│  Resource Collector      │        hello / ack / error     │  WebSocket Client        │
│  CPU / RAM / GPU / Temp  │                                │  Message Parser          │
└──────────────────────────┘                                └────────────┬─────────────┘
                                                                         │ I2C
                                                                         ▼
                                                                    ┌─────────┐
                                                                    │  OLED   │
                                                                    │ 128×64  │
                                                                    └─────────┘
```

Additional context:
- **mDNS** (`_resmon24._tcp.local`) lets the device find the desktop's address and port without any manual entry; discovery re-queries until the desktop appears.
- **Custom captive portal** (`ESP8266WebServer` + `DNSServer` from the ESP8266 core) lets the device join a WiFi network and capture its timezone without reflashing. It replaces the third-party `WiFiManager` library with a first-party implementation.
- **Adaptive display** switches the OLED between CLOCK and RESOURCE based on whether a desktop WebSocket session is live.
- **NTP** keeps the on-device clock accurate, using the timezone captured at onboarding (or a desktop override); a fixed fallback chain covers network flakiness.

## 2. Repository Layout

```
resmon24/
├── apps/
│   ├── desktop/                 # Electrobun (Bun) + React + Tailwind + TypeScript
│   └── firmware/                # ESP8266 firmware (Arduino + PlatformIO)
├── packages/
│   └── protocol/                # Shared communication protocol
│       ├── schema/              # JSON Schema — single source of truth
│       └── generated/
│           ├── typescript/      # Generated types for the desktop app
│           └── cpp/             # Generated types for the ESP8266 firmware
├── scripts/                     # Protocol generation and build utilities
├── docs/                        # This documentation set
└── README.md
```

> The `packages/protocols/` (plural) directory has been renamed to `packages/protocol/`, which now contains the schemas, generated types, and package config.

## 3. Component Responsibilities

### 3.1 Desktop — Bun Main Process (Electrobun) (`apps/desktop`)

| Module | Responsibility | Key constraints |
|---|---|---|
| App shell | Window lifecycle, tray, autostart | Runs headless-capable; closing window may keep streaming if enabled |
| Metrics collector | Sample CPU/RAM/GPU/temp/fans/network; normalize units | Must not block the event loop; subprocess collectors TTL-cached with failure backoff |
| WebSocket server | Accept one or more device connections, push updates | Enforce message size budget; per-client send queue; handshake/silence timeouts |
| mDNS advertiser | Publish `_resmon24._tcp` with TXT metadata | Must stay up for device discovery |
| Config store | Persist the last applied display configuration | JSON at `$XDG_CONFIG_HOME/resmon24/config.json` |
| IPC bridge | Expose typed API to renderer | No Node access from renderer; context isolation on |

### 3.2 Desktop — Renderer (`apps/desktop`)

React + Tailwind UI for device discovery, connection status, live local preview, screen/rotation configuration, optional timezone override, and logs. All privileged work goes through the typed IPC bridge.

### 3.3 Firmware (`apps/firmware`)

| Module | Responsibility | Source |
|---|---|---|
| `NetworkManager` | Custom captive portal (SSID, password, timezone), credential persistence (LittleFS), reconnect | `src/NetworkManager.cpp` |
| `ConfigStore` | `/wifi.json` + `/config.json` load/save, timezone validation and precedence | `src/ConfigStore.cpp` |
| `MonitorClient` | mDNS discovery, WebSocket session, heartbeat, message parsing via generated types | `src/MonitorClient.cpp` |
| `ScreenManager` | Display mode state machine (`SETUP`/`CONNECTING`/`CLOCK`/`RESOURCE`), screen rotation, stale detection | `src/ScreenManager.cpp` |
| `ClockService` | NTP sync using onboarding/desktop timezone, fallback chain | `src/ClockService.cpp` |
| `OledDisplay` | SSD1306 render primitives + CPU/memory screens + brightness | `src/OledDisplay.cpp` |

### 3.4 Protocol Package (`packages/protocol`)

- `schema/` holds JSON Schema documents — the authoritative contract.
- `generated/typescript/` and `generated/cpp/` are produced by `scripts/` and are **never hand-edited**.
- CI fails if generated output differs from a fresh run.

## 4. Runtime Data Flow

```
[desktop timer, default 1s]
        │
        ├─ collector.sample() ──► normalize ──► build resource_update
        │
        ├─ serialize JSON (≤ 1 KB budget)
        │
        └─ ws.send() ──────────────────────────────► [ESP8266]
                                                          │
                                              parse envelope (ArduinoJson)
                                                          │
                                              SessionState = RESOURCE
                                                          │
                                              ScreenManager.apply()
                                                          │
                                              OledDisplay.render()
                                                          │
                                              ws heartbeat / ack ──► [desktop]
```

Config path:

```
[desktop UI] ── config message ──► [ESP8266] ── persist /config.json ──► apply without reboot
```

Onboarding path:

```
[browser] ── HTTP form (SSID, password, timezone) ──► [ESP8266]
                                                          │
                                              validate + persist /wifi.json
                                                          │
                                              join WiFi ──► CLOCK mode
```

## 5. Display Mode State Machine

`SessionState` owns the OLED personality. It is independent of the protocol parser: the parser reports connection/liveness signals, and `SessionState` decides what to render.

```
                 no config
   BOOT ─────────────────────► SETUP (portal AP + IP)
     │                              │
     │ config present               │ submit valid form
     ▼                              ▼
 CONNECTING ◄────────────────── join WiFi
     │  connected                    ▲
     ▼                               │ 3 failed joins
  CLOCK ──────────────────────► SETUP
     │  ▲
     │  │ socket close / heartbeat timeout / stale (3×interval)
     ▼  │
  RESOURCE ◄──── welcome (session established)
```

| Mode | Trigger | Renders |
|---|---|---|
| `SETUP` | No config, or repeated join failures | AP SSID + portal IP + instructions |
| `CONNECTING` | WiFi join/rejoin in progress | Attempt counter / progress |
| `CLOCK` | WiFi up, no live session | Time, date |
| `RESOURCE` | `welcome` received and session live | Configured resource screens (rotation) |

Rules:
- Transitions must not block the main loop and must complete within one render cycle (< 1 s, KPI #7).
- `CLOCK` remains the safe default: it is the state whenever a session is absent, stale, or closed.
- Stale data (no `resource_update` for `3 × interval`) first marks the RESOURCE view stale, then returns to `CLOCK`.

## 6. State & Failure Handling

- **Device connection state**: `DISCOVERED → CONNECTING → CONNECTED → STALE → DISCONNECTED`. Stale is entered when no update is seen for `3 × interval`; the OLED marks it and then returns to CLOCK.
- **Display fallback**: any loss of a live session returns the device to CLOCK; WiFi loss moves it to CONNECTING and then SETUP after repeated failures.
- **Reconnect**: desktop retries with exponential backoff capped at 30 s; firmware retries its socket every 5 s. Neither requires a reboot.
- **WiFi loss**: firmware retries the stored credentials, then reopens the custom portal after repeated failures.
- **Config corruption**: if `/config.json` (or the timezone field) fails to parse, firmware falls back to compiled-in defaults (timezone `UTC`) and keeps running.
- **NTP failure**: `ClockService` reports time as invalid; `CLOCK` mode shows a syncing state rather than a garbage timestamp.

## 7. Security Architecture

- LAN-only trusted environment. No auth or TLS in the MVP; this is an explicit, documented trade-off.
- Bind the WS listener to a specific LAN interface; never expose on a public address.
- Only aggregate hardware metrics cross the wire — no PII, filenames, or process lists.
- WiFi credentials and timezone stay on the device; the desktop never receives them.
- The setup AP is open by design for first-run onboarding; it must time out after a bounded idle period once configured and must never echo stored secrets to the browser.
- Future: shared-token pairing (v1.2), optional `wss` evaluation gated on ESP8266 memory/perf measurements.

## 8. Firmware Constraints

| Constraint | Value / implication |
|---|---|
| SRAM | ~40 KB usable heap; keep JSON documents bounded and avoid dynamic `String` churn |
| Message size | Documented per-message budget ≤ 1 KB serialized |
| Loop model | Single-threaded, cooperative; no blocking calls longer than ~100 ms |
| Watchdog | Avoid starvation; assert zero resets over a 24 h soak (KPI #5) |
| Storage | LittleFS for `/wifi.json` (ssid, password, timezone) and `/config.json` (display config) |
| Portal | ESP8266 core `ESP8266WebServer` + `DNSServer`; no third-party portal library |
| Display | SSD1306 128×64 over I2C @ `0x3C` |

## 9. Technology Choices

| Layer | Choice | Rationale |
|---|---|---|
| Desktop shell | Electrobun (Bun + system webview) | Native Node/Bun access for metrics + rich React UI |
| UI | React + Tailwind + TypeScript | Matches project scaffolding; fast iteration |
| Metric source | `os` + `/proc`, `nvidia-smi`, `sensors` (lm-sensors) | Native reads for the hot path; subprocess collectors cached with timeouts |
| Transport | WebSocket (`ws`) | Bidirectional, low overhead, supported on ESP8266 |
| Discovery | mDNS (`bonjour-service`) | Zero-config on typical home LANs |
| Firmware framework | Arduino + PlatformIO | Mature ESP8266 tooling and libraries |
| Onboarding | Custom captive portal (`ESP8266WebServer` + `DNSServer`) | Own the form fields (SSID/password/timezone); remove third-party dependency |
| JSON (firmware) | ArduinoJson 7 | Bounded memory, well suited to ESP8266 |
| WS (firmware) | links2004/WebSockets | Proven ESP8266 client implementation |
| Schema | JSON Schema + codegen | Prevents type drift between TS and C++ |

## 10. Related Documents

- [`PRD.md`](./PRD.md) — requirements, KPIs, scope, risks
- [`protocol.md`](./protocol.md) — message catalog and schemas
- [`development.md`](./development.md) — setup, build, and test instructions
- [`roadmap.md`](./roadmap.md) — phased delivery plan
