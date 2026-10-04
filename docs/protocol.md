# Communication Protocol

The `resmon24` protocol is a JSON-over-WebSocket contract between the Linux desktop application and the ESP8266 firmware. **JSON Schema in `packages/protocol/schema/` is the single source of truth.** TypeScript types (desktop) and C++ structs (firmware) are generated from those schemas. This document explains the protocol; the schemas define it.

- **Protocol version**: `1`
- **Transport**: WebSocket, text frames, JSON object per frame
- **Default port**: `8765` (proposed — see PRD open questions)
- **Discovery**: mDNS service `_resmon24._tcp.local`
- **Trust model**: LAN-only, no authentication or TLS in v1

> Out of band: WiFi SSID, password, and timezone are captured by the device's **custom captive portal** (see [`architecture.md`](./architecture.md) and [`PRD.md`](./PRD.md) US-1). They are **not** part of this WebSocket protocol and never travel over it; the effective timezone may be reported/discovered here but credentials are local-only.

## 1. Design Principles

1. **Schema first** — no field ships unless it exists in `schema/` and generated code is committed.
2. **Forward/backward compatible** — unknown fields MUST be ignored; consumers MUST NOT fail on unrecognized keys.
3. **Bounded size** — any single serialized message MUST stay ≤ 1 KB (ESP8266 heap constraint).
4. **Explicit envelope** — every frame carries `type`, `proto`, `ts`, and optional `id`.
5. **Non-blocking** — sending side never blocks on a slow device; stale data is preferable to a stalled loop.
6. **Session-aware** — session lifecycle messages (`hello`/`welcome`, pings, closes) drive the device's CLOCK ↔ RESOURCE display modes (see §4.1).

## 2. Envelope

Every message is a JSON object with a common envelope:

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string enum | yes | Message type (see catalog) |
| `proto` | integer | yes | Protocol version this message conforms to (`1`) |
| `ts` | integer | yes | Sender timestamp, Unix ms |
| `id` | string | no | Correlation id; responses echo it |
| `data` | object | depends | Type-specific payload |

Example:

```json
{
  "type": "resource_update",
  "proto": 1,
  "ts": 1758880000000,
  "data": {
    "cpu": { "usage": 23.5, "cores": [18.0, 29.1] },
    "memory": { "used": 4831838208, "total": 16772268032, "percent": 28.8 }
  }
}
```

## 3. Message Catalog

### 3.1 `hello` — device → desktop

Sent immediately after the WebSocket opens. Identifies the device, reports its effective timezone, and lists its capabilities.

```json
{
  "type": "hello",
  "proto": 1,
  "ts": 1758880000000,
  "data": {
    "deviceId": "a4cf12b3e9d0",
    "firmware": "0.1.0",
    "board": "d1_mini",
    "timezone": "WIB-7",
    "capabilities": ["cpu", "memory", "clock", "display.ssd1306.128x64"]
  }
}
```

| Field | Type | Description |
|---|---|---|
| `deviceId` | string | Stable device identifier (MAC-derived) |
| `firmware` | string | Semantic version of firmware |
| `board` | string | Board identifier |
| `timezone` | string | Optional. Effective POSIX TZ captured at onboarding; lets the desktop display/override it |
| `capabilities` | string[] | Feature tokens the device can render/accept |

### 3.2 `welcome` — desktop → device

Acknowledges `hello`, assigns a session, and may override the push interval. **Receiving `welcome` establishes the session and switches the device to RESOURCE display mode.**

```json
{
  "type": "welcome",
  "proto": 1,
  "ts": 1758880000100,
  "data": {
    "sessionId": "s-7f3a91",
    "host": "workstation",
    "intervalMs": 1000,
    "serverVersion": "0.1.0"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `sessionId` | string | Session identifier for logging/correlation |
| `host` | string | Desktop hostname shown on an optional screen |
| `intervalMs` | integer | Requested push interval; device uses this to compute the stale timeout |
| `serverVersion` | string | Desktop app version |

### 3.3 `resource_update` — desktop → device

The core telemetry message. All metric groups are optional and independently present/absent so an older firmware can ignore unknown groups.

```json
{
  "type": "resource_update",
  "proto": 1,
  "ts": 1758880001000,
  "data": {
    "cpu": {
      "usage": 23.5,
      "tempC": 54.0,
      "cores": [18.0, 29.1, 21.4, 25.5],
      "freqMhz": 3600
    },
    "memory": {
      "used": 4831838208,
      "total": 16772268032,
      "percent": 28.8,
      "swapUsed": 0,
      "swapTotal": 2147483648
    },
    "gpu": {
      "usage": 61.0,
      "vramUsed": 2147483648,
      "vramTotal": 8589934592,
      "tempC": 67.0
    },
    "network": {
      "rxBytesPerSec": 1048576,
      "txBytesPerSec": 524288
    },
    "temperature": {
      "system": 41.0,
      "extras": [
        { "label": "NVMe", "tempC": 45.9 }
      ]
    },
    "fans": {
      "entries": [
        { "label": "FAN1", "rpm": 1200, "percent": 47 }
      ]
    },
    "uptimeSec": 483920
  }
}
```

| Group | Field | Type | MVP | Notes |
|---|---|---|---|---|
| `cpu` | `usage` | number 0–100 | ✅ | Overall utilization |
| `cpu` | `tempC` | number \| null | v1.1 | lm-sensors / hwmon package temp |
| `cpu` | `cores` | number[] 0–100 | ✅ | Per-core; omitted if unavailable |
| `cpu` | `freqMhz` | number | — | Not collected |
| `memory` | `used` | integer bytes | ✅ | 64-bit safe — see §5 |
| `memory` | `total` | integer bytes | ✅ | |
| `memory` | `percent` | number 0–100 | ✅ | Precomputed to save device CPU |
| `memory` | `swapUsed` / `swapTotal` | integer bytes | — | Not collected |
| `gpu` | `usage` | number 0–100 | v1.1 | `nvidia-smi` utilization |
| `gpu` | `vramUsed` / `vramTotal` | integer bytes | v1.1 | |
| `gpu` | `tempC` | number | v1.1 | |
| `network` | `rxBytesPerSec` / `txBytesPerSec` | integer bytes | v1.1 | `/proc/net/dev` deltas, loopback excluded |
| `temperature` | `system` | number \| null | v1.1 | Motherboard/chipset temp (lm-sensors) |
| `temperature` | `extras` | `{ label, tempC }[]` | v1.1 | Other labeled sensors (NVMe, ...), ≤ 4 |
| `fans` | `entries` | `{ label, rpm, percent? }[]` | v1.1 | lm-sensors fans, ≤ 6 |
| — | `uptimeSec` | integer | — | Not collected |

### 3.4 `config` — desktop → device

Applies display configuration. The device persists it and applies it without reboot.

```json
{
  "type": "config",
  "proto": 1,
  "ts": 1758880002000,
  "id": "cfg-1",
  "data": {
    "screens": ["cpu", "memory", "gpu", "network", "sensors"],
    "rotateMs": 5000,
    "brightness": 200,
    "timezone": "WIB-7"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `screens` | string[] | Ordered, enabled screens (max 5). Each entry is a single metric id (`cpu`, `memory`, `gpu`, `network`, `sensors`, `clock`, `wifi`) or a `+`-separated composite such as `cpu+memory+gpu+network`, which packs those metrics into one frame |
| `rotateMs` | integer | Rotation dwell time, 2000–60000 |
| `brightness` | integer | 0–255 |
| `dimAfterMs` | integer | Optional. Dim the display after this many ms without fresh samples; `0` disables. The desktop app no longer sends it |
| `timezone` | string | Optional POSIX TZ override; when present it takes precedence over the onboarding timezone |
| `showConnection` | boolean | Optional. The desktop app no longer sends it; the clock renders time/date only — use the `wifi` screen for SSID/IP |

**Composite screens**: a single-metric entry uses that metric's full-screen
layout (the `wifi` entry shows the device's WiFi SSID and IP address); an entry
with several metrics renders one row per metric (label left,
value right, bar where one exists), with `clock` occupying the top block. Each
entry is at most 39 characters; unknown tokens render a placeholder screen.

**Timezone precedence**: onboarding portal value (`/wifi.json`) → device default. If `config.timezone` is present it overrides for display and NTP config; the override is persisted alongside display config and the onboarding value is retained as the fallback if the override is later cleared.

### 3.5 `ack` — device → desktop

Confirms receipt/handling of a message that requested acknowledgment (currently `config`).

```json
{
  "type": "ack",
  "proto": 1,
  "ts": 1758880002050,
  "id": "cfg-1",
  "data": { "ok": true }
}
```

### 3.6 `error` — either direction

```json
{
  "type": "error",
  "proto": 1,
  "ts": 1758880003000,
  "id": "cfg-1",
  "data": {
    "code": "INVALID_PAYLOAD",
    "message": "screens[0] must be a known screen id"
  }
}
```

Suggested codes: `INVALID_PAYLOAD`, `UNSUPPORTED_TYPE`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_VERSION`, `INTERNAL`.

### 3.7 `ping` / `pong` — bidirectional

Heartbeat to detect dead links. A `pong` is sent in reply and echoes the `id` of the `ping` when present.

```json
{ "type": "ping", "proto": 1, "ts": 1758880004000, "id": "hb-42", "data": {} }
{ "type": "pong", "proto": 1, "ts": 1758880004010, "id": "hb-42", "data": {} }
```

- Desktop sends `ping` every 10 s when idle; device replies `pong`.
- Device sends `ping` every 15 s; desktop replies `pong`.
- If 3 consecutive pings go unanswered, the sender treats the link as dead and reconnects. On the device this also forces the display back to CLOCK mode.

## 4. Session Sequence

```
ESP8266                              Desktop
   │                                    │
   │──── ws open (mDNS/resolved host) ──│
   │──── hello ────────────────────────►│   (device is in CLOCK mode until welcome)
   │◄─── welcome ───────────────────────│   (device switches to RESOURCE mode)
   │──── ack (optional) ───────────────►│
   │◄─── config ────────────────────────│
   │──── ack ──────────────────────────►│
   │◄─── resource_update ───────────────│  (repeating @ intervalMs)
   │◄─── resource_update ───────────────│
   │──── ping ─────────────────────────►│
   │◄─── pong ──────────────────────────│
   │                                    │
   │──── ws close / network loss ──────►│   (device returns to CLOCK mode, retry per §6)
```

### 4.1 Display Mode Transitions

The wire protocol drives the device's display mode state machine (see [`architecture.md` §5](./architecture.md#5-display-mode-state-machine)):

| Event | Device display mode |
|---|---|
| Boot, no stored config | `SETUP` (custom portal) |
| Valid portal submit / stored config, joining WiFi | `CONNECTING` |
| WiFi connected, no `welcome` yet | `CLOCK` |
| `welcome` received | `RESOURCE` |
| `resource_update` stale for `3 × interval` | `RESOURCE` (stale marker) → `CLOCK` |
| `ping` unanswered × 3 / socket close | `CLOCK` |
| WiFi drop | `CONNECTING` → `SETUP` after repeated failures |

None of these transitions require a reboot. The protocol does not carry an explicit "mode" field; the mode is derived from connection and liveness signals, which keeps the wire format minimal.

## 5. Encoding Rules

- **Numbers**: JSON numbers in decimal. No NaN/Infinity — use `null` or omit the field.
- **Byte counts**: serialize as JSON integers. Values above 2³¹ are authorized to be encoded as strings if a firmware build lacks 64-bit JSON support. The schema documents both forms for `*Total` / `*Used` byte fields:
  ```json
  "memory": { "used": "4831838208", "total": "16772268032", "percent": 28.8 }
  ```
  Consumers MUST accept either integer or decimal-string for byte fields. Producers SHOULD emit integers when safe.
- **Percentages**: `0.0`–`100.0`, one decimal recommended.
- **Temperatures**: degrees Celsius, number.
- **Timestamps**: Unix epoch milliseconds, integer.
- **IDs**: short opaque strings (≤ 32 chars).
- **Timezone**: POSIX TZ string (e.g., `WIB-7`, `UTC`, `America/New_York`). Consumers SHOULD validate before applying and fall back to `UTC` if unparseable.
- **Unknown enum values**: consumers MUST ignore unknown screen ids/capabilities rather than error.
- **Field order**: not significant.

## 6. Reliability Rules

1. **Stale detection**: device considers data stale when `now - lastUpdate.ts > 3 × intervalMs` and renders a stale marker while retaining last values, then returns to CLOCK mode.
2. **Message size**: producers MUST NOT exceed 1 KB serialized. If over budget, drop optional groups before dropping the whole message.
3. **Lossy by design**: `resource_update` is fire-and-forget; no retransmission. A missed sample is superseded by the next.
4. **Reconnect**: exponential backoff (desktop) capped at 30 s; fixed 5 s retry (device). On reconnect a fresh `hello`/`welcome` cycle runs.
5. **Display fallback**: any session loss (close, heartbeat timeout, staleness) MUST return the device to CLOCK mode within 1 s; credentials/timezone remain intact for the next session.
6. **Version mismatch**: if `proto` is unsupported, reply `error` with `UNSUPPORTED_VERSION` and close cleanly.
7. **Malformed frame**: log, reply `error` (`INVALID_PAYLOAD`) where possible, and drop the frame — never crash the loop.

## 7. Schema Package Layout

```
packages/protocol/
├── schema/
│   ├── envelope.schema.json
│   ├── hello.schema.json
│   ├── welcome.schema.json
│   ├── resource_update.schema.json
│   ├── config.schema.json
│   ├── ack.schema.json
│   ├── error.schema.json
│   ├── ping.schema.json
│   └── pong.schema.json
└── generated/
    ├── typescript/            # union type + per-message interfaces
    └── cpp/                   # structs + (de)serialization helpers
```

`scripts/` contains the generator invoked by CI. Generated files carry a header stating they are machine-generated and must not be edited.

> The onboarding form (SSID/password/timezone) is **not** a WebSocket message; it is a local HTTP form served by the device's custom captive portal. Only the effective timezone is exposed over the protocol (via `hello` and the optional `config.timezone` override).

## 8. Worked Example — adding a new metric

To add `cpu.fanRpm`:

1. Add the property to `schema/resource_update.schema.json` (optional, integer).
2. Run the generation script.
3. Commit schema + regenerated TS/C++.
4. Implement collection on the desktop (ignore if unsupported hardware).
5. Implement rendering on a screen; older firmware simply ignores the field.

CI fails if step 3 is skipped.

## 9. Open Protocol Questions

1. Confirm default port `8765` and whether it should be configurable.
2. Byte fields: always integer, always string, or dual-encoded as documented in §5?
3. Should `welcome` push initial state (current config) to reduce round-trips?
4. Do we need a `capabilities`-gated compression scheme (e.g., delta encoding) before MVP?
5. Timezone precedence: confirm desktop `config.timezone` overrides the onboarding value (proposed) and whether `hello.timezone` should always be present.

See [`PRD.md` §5.3](./PRD.md#53-open-questions-to-resolve-during-review) for cross-cutting open questions.
