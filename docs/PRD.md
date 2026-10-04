# PRD: resmon24 — External Hardware Resource Monitor

- **Status**: Draft for review
- **Version**: 1.1
- **Owner**: bayu242
- **Last updated**: 2026-09-26

---

## 1. Executive Summary

**Problem Statement**
Linux users who care about machine health (developers, homelab operators, gamers) have no lightweight, always-on, glanceable way to see CPU/RAM/GPU load without stealing screen real estate or context-switching to a monitoring app on the monitored machine itself. Existing tools require the monitored OS to render the dashboard, which is unavailable during fullscreen workloads, headless operation, or when the display is busy.

**Proposed Solution**
`resmon24` is an open-source system where a Linux desktop application (Electrobun + React + TypeScript) samples hardware metrics and streams them over a local WebSocket to an ESP8266 device that renders them on a small OLED display. A schema-first protocol package is the single source of truth, with TypeScript and C++ types generated from JSON Schema so both ends can never drift. The device is onboarded through a **custom captive portal** that collects WiFi SSID, WiFi password, and timezone, and it runs an **adaptive display**: it shows a clock and date whenever no desktop session is active, then automatically switches to the resource monitor once the desktop connects.

**Success Criteria (measurable KPIs)**

| # | KPI | Target | Measurement |
|---|-----|--------|-------------|
| 1 | End-to-end metric freshness | p95 ≤ 2 s from sample to OLED pixel update at a 1 s push interval | Instrumented timestamp delta, automated soak test |
| 2 | Stream stability | ≥ 99.5% successful messages over 24 h continuous run on a stable LAN | Message counter on desktop vs. ESP ack/pong log |
| 3 | Setup time to first displayed metric | ≤ 10 min for a maker with parts on hand, from flashing to seeing CPU usage | Moderated task test, n ≥ 5 participants |
| 4 | Protocol type generation | 100% of committed schema fields have generated TS + C++ types; generation is reproducible in CI | `scripts/` codegen diff check in CI |
| 5 | Resource footprint on ESP8266 | Firmware heap usage < 60% of free heap at steady state; no watchdog resets over 24 h | `ESP.getFreeHeap()` telemetry + reset counter |
| 6 | Desktop idle overhead | < 2% CPU and < 150 MB RSS on the reference machine while streaming | Bun/Electrobun process metrics over 1 h |
| 7 | Display mode switch latency | Auto-switch CLOCK ↔ RESOURCE within 1 s of session change, no blank frame beyond one render cycle | Timestamped mode-transition log on device |

---

## 2. User Experience & Functionality

### 2.1 User Personas

- **P1 — Maker / Developer (primary)**: Comfortable with PlatformIO, GitHub, and Linux CLI. Wants a hackable, extensible project they can build, modify, and extend with more sensors/displays. Distribution: open-source, build-from-source.
- **P2 — Homelab / Enthusiast Operator**: Runs a Linux box (server, NAS, workstation) and wants a dedicated small display showing load. Willing to configure WiFi via a captive portal but not to write code.
- **P3 — Contributor**: Wants to add a new metric, display, or transport. Needs a clear protocol contract, codegen, and test harness.

### 2.2 User Stories & Acceptance Criteria

#### US-1 — First-time onboarding via custom WiFi manager (P2)
> As an enthusiast, I want the ESP8266 to host its own setup portal where I can enter my WiFi credentials and timezone so that the device joins my network and shows the correct local time without recompiling firmware.

**Acceptance Criteria**
- On boot with no stored configuration, the device broadcasts a `Resmon24-Setup` AP within 15 s; the OLED shows the AP SSID and portal IP (`192.168.4.1`).
- The **custom captive portal** (ESP8266 core `ESP8266WebServer` + `DNSServer`, no third-party portal library) serves a form with exactly three fields — **WiFi SSID**, **WiFi password**, **timezone** (curated dropdown).
- Portal validates before persisting: SSID must be non-empty; the timezone must be a known POSIX TZ string from the dropdown. Invalid submissions re-render the form with an inline error and are not saved.
- On submit, the device stores `ssid`, `password`, and `timezone` in `/wifi.json` on LittleFS; values survive power cycle.
- The device browses for the desktop via mDNS; no manual monitor-server IP or port is ever entered.
- The device attempts connection immediately after save; after ≥ 3 consecutive failures it reopens the portal automatically.
- A settings-reset path exists (portal action and/or erase) that clears `/wifi.json` and returns to onboarding.
- While connected, the portal can be brought up on demand (e.g., a forced config mode) without unnecessarily dropping the active WiFi session.
- If NTP time is unavailable, the device still proceeds to the CLOCK mode without blocking the main loop > 100 ms per iteration.

#### US-2 — Desktop discovers device and connects (P1/P2)
> As a user, I want the desktop app to find my ESP8266 on the LAN automatically so that I don't have to type IP addresses.

**Acceptance Criteria**
- Desktop advertises `_resmon24._tcp` over mDNS and/or browses for device advertisement; discovered devices appear in a list within 5 s of the device joining the LAN.
- The device discovers the desktop's address and port automatically over mDNS; there is no manual entry fallback.
- Selecting a device opens a WebSocket (`ws://<host>:<port>`) and completes the `hello`/`welcome` handshake; connection status is shown as Connecting / Connected / Error.
- Reconnect uses exponential backoff capped at 30 s, and recovers without app restart after network drop or device reboot.

#### US-3 — Live resource streaming (P1/P2)
> As a user, I want CPU and memory usage pushed to the device continuously so that the OLED reflects reality at a glance.

**Acceptance Criteria**
- Desktop samples CPU (total + per-core where available) and memory (used/total/percent) at a configurable interval, default 1000 ms, range 250–10000 ms.
- Each sample is emitted as a valid `resource_update` message (see `docs/protocol.md`) and does not exceed the documented size budget.
- ESP updates the OLED within one render cycle of receiving a message and never visibly flickers (full-frame redraw only when content changes).
- Stale-data rule: if no update is received for `3 × interval`, the device shows a "No signal" indicator while keeping the last values visible, then auto-returns to CLOCK mode (US-6).
- Disconnect rule: if the socket closes, the device retries the connection every 5 s, shows connection state on the OLED, and falls back to clock mode (US-6).

#### US-4 — Configurable display screens (P1)
> As a maker, I want to choose which metric groups the device shows and how they rotate so that the small screen stays useful to me.

**Acceptance Criteria**
- Desktop config UI lets the user enable/disable screens (CPU, Memory, GPU [post-MVP], Clock, Network) and set rotation dwell time (2–60 s).
- Effective configuration is sent as a `config` message; device persists it in LittleFS and applies it without reboot.
- Configuration survives device power cycle; a factory default is applied if stored config is corrupt.
- At least two screens have independent tests in the render layer.

#### US-5 — Add a new metric/display (P3)
> As a contributor, I want a schema-first workflow so that adding a field automatically produces correct types on both ends.

**Acceptance Criteria**
- Adding a field to `packages/protocol/schema/*.json` and running the generation script updates `packages/protocol/generated/typescript` and `generated/cpp` in one command.
- CI fails if generated output is out of sync with schema.
- Unknown/extra JSON fields are ignored (non-`additionalProperties: false` at the envelope level) so an older firmware tolerates a newer desktop and vice versa.

#### US-6 — Adaptive display mode (P1/P2)
> As a user, I want the device to show a clock and date when my desktop app is not streaming, and to switch to resource monitoring automatically when it is, so that the screen is never blank and never stale.

**Acceptance Criteria**
- The firmware maintains an explicit display mode state machine: `SETUP`, `CONNECTING`, `CLOCK`, `RESOURCE`.
- `SETUP` shows the AP SSID and portal IP while the custom WiFi manager is active.
- `CONNECTING` shows WiFi connection progress/retries.
- `CLOCK` is active whenever WiFi is connected but no live desktop session exists; it renders local time, date, and WiFi/IP status using the onboard timezone.
- On receipt of a valid `welcome` (session established), the device auto-switches to `RESOURCE` within 1 s and renders the configured resource screens.
- On socket close, heartbeat timeout, or `3 × interval` staleness, the device auto-returns to `CLOCK` within 1 s; if WiFi itself drops it moves to `CONNECTING`, then to `SETUP` after repeated failures.
- Mode transitions require no reboot and cause no visible blank frame beyond one render cycle.
- The clock in `CLOCK` mode uses the timezone captured during onboarding, unless overridden by the desktop `config` message (precedence defined in `docs/protocol.md`).

### 2.3 User Flow (MVP)

```
Power on ESP8266
      │
      ├─ Config stored? ──No──► Setup AP + custom portal ──► save SSID / password / TZ ─┐
      │                                                                                   │
      └────────────────Yes───────────────────────────────────────────────────────────────┤
                                                                                           ▼
                                                             Connect to WiFi ──► obtain IP
                                                                                           │
                                              no desktop session yet ──► CLOCK mode (time+date)
                                                             broadcast mDNS │
                                                                                           ▼
Desktop app start ──► discover device ──► WS connect ──► hello ──► welcome
                                                                                           │
                                                          auto-switch to RESOURCE mode ─────┤
                                              stream resource_update ◄─────────────────────┘
                                                                                           │
                                                           ESP parses ──► OLED render
                                                                                           │
                              socket close / stale ──► auto-return to CLOCK mode ◄──────────┘
                              config message (screens, interval, TZ) ◄─────────────────────┘
```

### 2.4 Non-Goals (MVP)

- No Windows or macOS desktop support (Linux only).
- No cloud relay, remote access, or internet exposure of the WebSocket.
- No authentication/TLS on the link (trusted LAN only).
- No GPU/VRAM/temperature/fan metrics in MVP (protocol reserves fields; collection deferred).
- No OTA firmware updates in MVP.
- No mobile app or web dashboard.
- No historical logging, graphing, or alerting — this is a live gauge, not a telemetry store.
- No support for boards other than ESP8266 (e.g., ESP32) in MVP, though transport is designed to be portable.
- No third-party captive-portal/configuration library (onboarding is a first-party custom implementation).

---

## 3. AI System Requirements

**Not applicable.** `resmon24` contains no ML/AI components, model inference, or LLM features in the MVP or v1.x roadmap. If anomaly detection ("your CPU has been pegged for 10 min") is pursued in v2.0, this section will be expanded with tool requirements, an evaluation dataset, and a quality benchmark before implementation. No AI dependency may be introduced without a PRD amendment.

---

## 4. Technical Specifications

### 4.1 Architecture Overview

```
┌──────────────────────────────── Linux Desktop ────────────────────────────────┐
│  Bun Main Process (Electrobun)                                                │
│    ├── Metrics Collector ──► os//proc, nvidia-smi, lm-sensors                 │
│    ├── WebSocket Server (ws) ──► push resource_update                         │
│    ├── mDNS Advertiser (bonjour-service)                                      │
│    └── IPC bridge (typed)                                                     │
│  Renderer (React + Tailwind + TS)                                             │
│    ├── Device discovery & connection status                                   │
│    ├── Screen/rotation/dim + timezone configuration, profiles                 │
│    ├── Connection diagnostics + live local preview + logs                     │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │  WebSocket / JSON  (LAN, ws://)
                                ▼
┌──────────────────────────── ESP8266 (d1_mini) ────────────────────────────────┐
│  NetworkManager (custom captive portal: SSID + password + timezone, LittleFS) │
│  WebSocketClient (links2004/WebSockets)                                       │
│  MessageParser (ArduinoJson 7) ── validates envelope + dispatches              │
│  SessionState (SETUP → CONNECTING → CLOCK ⇄ RESOURCE)                          │
│  ScreenManager ──► OledDisplay (Adafruit SSD1306, 128×64)                      │
│  ClockService (NTP using onboarding/desktop timezone)                         │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Data flow**: Desktop samples on a timer → normalizes into schema-valid `resource_update` → serializes → pushes over WS → firmware parses envelope → ScreenManager selects active screen → OLED renders. Config flows the opposite way via a `config` message persisted to LittleFS. Independently, `SessionState` decides whether the device shows CLOCK (no session) or RESOURCE (session active) based on connection/heartbeat/staleness signals.

**Component boundaries**
- `apps/desktop` — Electrobun/Bun main (native access) and renderer (UI) with a typed RPC contract.
- `apps/firmware` — Arduino/PlatformIO, dependency-light, non-blocking loop.
- `packages/protocol` — JSON Schema source of truth + generated TS/C++.
- `scripts` — codegen and build utilities used by CI.

### 4.2 Integration Points

| Integration | Direction | Protocol | Notes |
|---|---|---|---|
| Desktop → ESP | Push | WebSocket, JSON text frames | Default port TBD (proposed `8765`), single client per desktop in MVP |
| ESP → Desktop | Push | WebSocket, JSON text frames | `hello`, `ack`, `error`, heartbeat |
| DNS-SD | Bidirectional | mDNS `_resmon24._tcp.local` | Service TXT: `id`, `fw`, `proto`, `board` |
| NTP | ESP → internet | UDP 123 | `0.id.pool.ntp.org` + 3 fallbacks; timezone from onboarding (or desktop `config` override) |
| WiFi config | ESP ↔ browser | HTTP captive portal | Custom portal (`ESP8266WebServer` + `DNSServer`) on `192.168.4.1`; collects SSID, password, timezone |
| Persistence (ESP) | local | LittleFS | `/wifi.json` (ssid, password, timezone), `/config.json` (display config) |
| Persistence (desktop) | local | JSON in app config dir (`~/.config/resmon24/profiles.json`) | Named per-device display profiles, preferences, optional timezone override |

**Ports/messages**: see `docs/protocol.md` for the complete message catalog and JSON Schemas.

### 4.3 Security & Privacy

- **Trust boundary**: The WebSocket listener is LAN-only. Bind to the desktop's LAN interface, never `0.0.0.0` on a public interface, and document firewall guidance.
- **No secrets in transit**: MVP explicitly ships without auth/TLS; this is an accepted risk for a trusted home LAN and MUST be stated in the README and in-app.
- **Data collected**: only aggregate hardware metrics (percentages, temperatures, byte counts). No filenames, process lists, keystrokes, or user data ever leave the machine.
- **Storage**: WiFi credentials and timezone are stored locally on the device (LittleFS) and never sent to the desktop; desktop stores only device addresses/preferences.
- **Portal exposure**: the setup AP is open by design for first-run onboarding. It MUST time out after a bounded idle period once configured, and the portal MUST NOT serve device secrets back to the browser.
- **Posture for v1.x**: pairing token (see Roadmap) to prevent a rogue client on a shared LAN from feeding bogus data; TLS deferred due to ESP8266 memory/CPU cost.
- **Compliance**: no PII processed; no telemetry/phoning home; project ships under an OSI license (TBD — proposed MIT).

### 4.4 Testing Strategy

- **Protocol codegen**: CI job regenerates TS/C++ and fails on diff.
- **Schema conformance**: shared fixture vectors (valid + invalid) exercised by both a Node validator test and a C++ parser test.
- **Portal tests**: form validation (SSID required; POSIX TZ parsing) and LittleFS persistence round-trip in a `native` test env; manual captive-portal smoke on Android + iOS browsers.
- **Mode transition tests**: unit-test `SessionState` transitions for `welcome`, socket close, heartbeat timeout, staleness, and WiFi loss; assert no blank frames.
- **Desktop unit tests**: collector normalization, reconnect backoff, message size budget.
- **Firmware tests**: platformio `native` test env for parser/ScreenManager logic where feasible; hardware-in-the-loop smoke test for WiFi + OLED.
- **End-to-end soak**: 24 h run asserting KPIs #1, #2, #7; watchdog/reset counter asserted zero.
- **Golden render snapshots**: OLED framebuffer serialized and compared to expected bitmaps for each screen and for each display mode.

---

## 5. Risks & Roadmap

### 5.1 Phased Rollout

**MVP — "It tells me my CPU/RAM load"**
- Firmware: custom WiFi manager portal (SSID + password + timezone), adaptive display modes (`SETUP`/`CONNECTING`/`CLOCK`/`RESOURCE`), WS client, message parser, ScreenManager, CPU + Memory screens, Clock screen.
- Desktop: Electrobun (Bun) shell, collector (CPU/RAM), WS server, mDNS, device list, connect/disconnect, interval + screen config (+ optional timezone override), local preview.
- Protocol: schema v1 (`hello`, `welcome`, `resource_update`, `config`, `ack`, `error`, `ping`/`pong`), codegen, docs.
- Exit criteria: KPIs #1–#3, #5, #7 met; all MVP acceptance criteria in §2.2 pass.

**v1.1 — "More signal, less babysitting"**
- Add GPU utilization/VRAM (nvidia-smi), CPU/motherboard temperature (lm-sensors), fan speed.
- Screen rotation with dwell time; brightness/timeout control; compact numeric formatting.
- Reconnect hardening, per-device named profiles, packaged Linux build (AppImage/deb).

**v1.2 — "Safe and updatable"**
- Shared-token pairing; optional TLS (`wss`) evaluation.
- OTA firmware updates driven from the desktop.
- Additional ESP8266 boards + first ESP32 support; alternative displays (SSD1309, SH1106, TFT).

**v2.0 — "Platform"**
- Plugin API for metrics, displays, and transports.
- Optional local history/graphing and threshold alerts.
- (If pursued) on-device anomaly detection — requires a new PRD section.

### 5.2 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ESP8266 RAM/heap exhaustion from large JSON | High | High | Cap message size (≤ 1 KB), ArduinoJson 7 with bounded doc, stream per-metric or delta updates, no dynamic `String` churn in hot path |
| WiFi/mDNS reliability on consumer routers | High | Medium | Aggressive reconnect with backoff; re-query mDNS until found; surface link state on OLED |
| Custom captive portal misses OS captive-portal detection quirks | Medium | Medium | Use ESP8266 core HTTP+DNS servers, test Android/iOS; always show the numeric IP as a fallback path |
| Invalid/missing timezone breaks clock and NTP config | Medium | Low | Validate POSIX TZ at the portal; default to `UTC`; allow desktop `config` override |
| GPU/temperature collection varies by distro/hardware | Medium | Medium | Capability detection with graceful degradation; mark fields optional in schema |
| Metric collection stalls the Bun main loop | Medium | Medium | Async/non-blocking sampling, isolate in worker or timer, add timeouts around `nvidia-smi` |
| Firmware/desktop protocol drift | Medium | High | Schema-first codegen + CI sync gate + forward-compatible unknown-field handling |
| LAN-only no-auth model abused on shared networks | Low | Medium | Document threat model; schedule token auth for v1.2 |
| Watchdog resets causing visible dropouts | Medium | High | Non-blocking loop, yield/delay budget, heap soak test, reset counter KPI #5 |
| Scope creep into full dashboard/cloud | Medium | Medium | Enforced Non-Goals (§2.4); roadmap gate before any scope expansion |

### 5.3 Open Questions (to resolve during review)

1. Default WebSocket port and mDNS service name confirmation (`_resmon24._tcp`)?
2. License choice (MIT vs. Apache-2.0)?
3. Should the desktop also enforce a per-message PII/clipboard guard, or is aggregate-only a given?
4. Timezone is now captured at onboarding and overridable by desktop `config` — confirm precedence (proposed: desktop override wins when present) and whether a curated timezone picker is needed vs. free-text POSIX TZ.
5. Which exact ESP8266 board matrix is "officially supported" (d1_mini only vs. NodeMCU v3 too)?
