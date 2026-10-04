# Roadmap

Phased delivery plan for `resmon24`, derived from [`PRD.md` §5](./PRD.md#5-risks--roadmap). Dates are intentionally omitted until capacity is known; phases are gated by exit criteria, not calendars.

## Phase Summary

| Phase | Theme | Headline capabilities | Gate |
|---|---|---|---|
| MVP | It tells me my CPU/RAM load | Custom WiFi onboarding (SSID/password/timezone), adaptive CLOCK ⇄ RESOURCE display, CPU + Memory screens, WS streaming, discovery, config | All MVP acceptance criteria pass; KPIs #1–#3, #5, #7 met |
| v1.1 | More signal, less babysitting | GPU, temperature, fans, screen rotation, packaged Linux build | KPI #6 met; ≥ 3 metric screens stable over 24 h |

---

## MVP — "It tells me my CPU/RAM load"

**Goal**: A maker can flash the device, onboard it with WiFi credentials + timezone via the device's own portal, run the desktop app, and see live CPU and memory usage on the OLED — with a clock/date fallback whenever the desktop isn't streaming — reliably within 10 minutes.

### Firmware
- [x] Custom WiFi manager: captive portal (`ESP8266WebServer` + `DNSServer`) collecting **SSID, password, timezone** (dropdown)
- [x] Portal validation (SSID required, POSIX TZ parse) + persistence to `/wifi.json`
- [x] Remove `tzapu/WiFiManager` dependency
- [x] `SessionState` display mode state machine (`SETUP`/`CONNECTING`/`CLOCK`/`RESOURCE`) in `ScreenManager`
- [x] CLOCK mode: time + date + WiFi/IP fallback when no session
- [x] Auto-switch to RESOURCE on `welcome`, auto-return to CLOCK on disconnect/stale
- [x] `ClockService` uses onboarding timezone (desktop override respected)
- [x] WebSocket client (links2004/WebSockets) connecting to the desktop
- [x] Desktop discovery via mDNS browse (`ESP8266mDNS` queryService for `_resmon24._tcp`); no manual-IP fallback
- [x] Heartbeat (JSON `ping` every 15 s) + link timeout reconnect
- [x] Message parser (ArduinoJson 7) using generated C++ types, envelope validation + unknown-field tolerance
- [x] `ScreenManager` with active-screen selection, rotation, and stale-data handling
- [x] CPU screen (overall + per-core bars)
- [x] Memory screen (used/total/percent)
- [x] Clock screen (already partially present via `ClockService`)
- [x] Non-blocking loop
- [ ] 24 h soak on hardware: zero watchdog resets (KPI #5)

### Desktop
- [x] Electrobun (Bun) shell with typed RPC bridge (`src/bun`, `src/tabview`)
- [x] Metrics collector: CPU + memory (`os` sampling, `systeminformation` fallback)
- [x] WebSocket server (`Bun.serve`) with per-client sessions + 1 KB message budget
- [x] mDNS advertiser `_resmon24._tcp` (`bonjour-service`) + connected-device list UI
- [x] Reconnect handling (device reconnects every 5 s; server accepts reconnects)
- [x] Config UI: interval, enabled screens, rotation, brightness, optional timezone override
- [x] Local live preview (CPU/memory gauges) + connection status/errors
- [x] Consume generated protocol types via `@resmon24/protocol` path alias

### Protocol
- [x] JSON Schemas: `envelope`, `hello` (incl. optional `timezone`), `welcome`, `resource_update`, `config` (incl. optional `timezone`), `ack`, `error`, `ping`, `pong`
- [x] Generation script for TypeScript + C++ (`scripts/generate-protocol.mjs`)
- [x] CI drift gate (`scripts/generate-protocol.mjs --check`)
- [x] Generated C++ types compile under PlatformIO (compile shim in `apps/firmware/src/ProtocolTypes.cpp`)
- [x] Generated TypeScript types typecheck with `tsc` (`packages/protocol/tsconfig.json`)
- [x] Generated TypeScript types consumed by the desktop app (`@resmon24/protocol`)
- [ ] Shared valid/invalid fixture vectors
- [ ] Wire codegen `--check` into CI pipeline

### Docs
- [x] PRD
- [x] Architecture
- [x] Protocol
- [x] Development guide
- [x] Roadmap
- [ ] README (getting started)

**Exit criteria**: KPIs #1 (p95 freshness ≤ 2 s), #2 (≥ 99.5% delivery over 24 h), #3 (≤ 10 min setup), #5 (heap < 60%, zero resets), #7 (mode switch ≤ 1 s, no blank frame) met; all §2.2 acceptance criteria pass.

---

## v1.1 — "More signal, less babysitting"

**Goal**: Richer, more configurable dashboards with a packaged install path.

- [x] GPU utilization + VRAM + temperature (`nvidia-smi`)
- [x] CPU/motherboard temperature and fan speed (`lm-sensors`)
- [x] Network throughput (rx/tx) screen
- [x] Screen rotation with dwell time; brightness/timeout control (`dimAfterMs`)
- [x] Composite screens (several metrics per frame) with Basic/Custom picker
- [x] Curated timezone picker in the desktop config (vs. free-text POSIX TZ)
- [x] Compact value formatting (GiB/%/rate, adaptive decimals)
- [x] Per-device named profiles persisted in the app config dir (`~/.config/resmon24/profiles.json`)
- [x] Packaged Linux builds (AppImage + `.deb`) with release artifacts
- [x] Reconnect hardening and connection diagnostics panel

**Exit criteria**: KPI #6 (desktop overhead < 2% CPU, < 150 MB RSS) met; metric screens stable over a 24 h run; install path verified on clean Ubuntu LTS and one Arch-based distro.


## Backlog / Not Scheduled

- Windows/macOS desktop support
- Cloud relay / remote viewing
- Mobile app
- RGB/LED strip or e-ink variants
- Home Assistant integration

Items here are explicitly out of scope until promoted via a PRD amendment (see Non-Goals in [`PRD.md` §2.4](./PRD.md#24-non-goals-mvp)).

## Cross-References

- Requirements, KPIs, risks: [`PRD.md`](./PRD.md)
- Components and data flow: [`architecture.md`](./architecture.md)
- Message contract: [`protocol.md`](./protocol.md)
- Setup and contribution: [`development.md`](./development.md)
