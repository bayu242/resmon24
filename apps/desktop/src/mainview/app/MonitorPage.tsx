import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getLatestSample, getMonitorState, setMonitorConfig, startMonitor, stopMonitor } from "./rpc";
import type { ResourceUpdateMessage } from "@resmon24/protocol";
import type { MonitorState, SetMonitorConfigParams } from "../../stubs/types";
import {
  BASIC_SCREENS,
  COMBO_SCREENS,
  MAX_SCREENS,
  METRIC_LABELS,
  METRIC_TOKENS,
  makeScreenId,
  screenLabel,
  type MetricToken,
} from "../../stubs/screens";
import {
  formatBytesPair,
  formatPercent,
  formatRate,
  formatRpm,
  formatTemp,
  formatUptime,
} from "./format";
import { TIMEZONE_OPTIONS } from "./timezones";

export function MonitorPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["monitor-state"],
    queryFn: getMonitorState,
    refetchInterval: 1500,
  });

  const sampleQuery = useQuery({
    queryKey: ["monitor-sample"],
    queryFn: getLatestSample,
    refetchInterval: 1000,
  });

  const [form, setForm] = useState<SetMonitorConfigParams | null>(null);
  useEffect(() => {
    if (data && form === null) {
      setForm({
        intervalMs: data.config.intervalMs,
        rotateMs: data.config.rotateMs,
        brightness: data.config.brightness,
        timezone: data.config.timezone,
        screens: [...data.config.screens],
      });
    }
  }, [data, form]);

  const applyState = (state: MonitorState) => {
    queryClient.setQueryData(["monitor-state"], state);
  };

  const save = useMutation({
    mutationFn: (params: SetMonitorConfigParams) => setMonitorConfig(params),
    onSuccess: applyState,
  });

  const stopMutation = useMutation({ mutationFn: stopMonitor, onSuccess: applyState });
  const startMutation = useMutation({ mutationFn: startMonitor, onSuccess: applyState });

  const controlError = stopMutation.isError
    ? String(stopMutation.error)
    : startMutation.isError
      ? String(startMutation.error)
      : null;

  const sample = sampleQuery.data ?? data?.latestSample ?? null;

  return (
    <div className="p-10 max-w-5xl">
      <div className="flex items-end justify-between gap-4 mb-6">
        <h1 className="rb-h2 uppercase">Resource Monitor</h1>
        <div className="flex items-center gap-3">
          <StatusPill running={!!data?.running} />
          {data?.running ? (
            <button
              type="button"
              className="rb-btn rb-btn--secondary rb-btn--sm"
              disabled={stopMutation.isPending}
              onClick={() => stopMutation.mutate()}
            >
              Stop server
            </button>
          ) : (
            <button
              type="button"
              className="rb-btn rb-btn--secondary rb-btn--sm"
              disabled={startMutation.isPending}
              onClick={() => startMutation.mutate()}
            >
              Start server
            </button>
          )}
        </div>
      </div>
      <div className="h-[5px] bg-ink w-40 mb-6" />
      <p className="text-[16px] leading-[1.6] mb-10 max-w-xl">
        Streams CPU, memory, GPU, network, and sensor metrics over WebSocket to
        ESP8266 devices on the LAN.
      </p>

      {isError && (
        <div className="mb-6 rb-alert rb-alert--error">
          Error: {String(error)}
        </div>
      )}

      {controlError && (
        <div className="mb-6 rb-alert rb-alert--error break-all">{controlError}</div>
      )}

      {data?.lastError && (
        <div className="mb-6 rb-alert rb-alert--warning break-all">
          {data.lastError}
        </div>
      )}

      {isLoading && <div className="h-24 rb-skeleton" />}

      {data && (
        <div className="grid gap-6">
          <ServerCard state={data} sample={sample} />

          {form && (
            <ConfigCard
              form={form}
              onChange={setForm}
              saving={save.isPending}
              onSave={() => save.mutate(form)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ running }: { running: boolean }) {
  return (
    <span className={running ? "rb-status rb-status--success" : "rb-status"}>
      {running ? "Running" : "Stopped"}
    </span>
  );
}

function ServerCard({
  state,
  sample,
}: {
  state: MonitorState;
  sample: ResourceUpdateMessage | null;
}) {
  const data = sample?.data;
  const cpu = data?.cpu;
  const memory = data?.memory;
  const gpu = data?.gpu;
  const network = data?.network;
  const temperature = data?.temperature;
  const fans = data?.fans;

  const sensorCells: string[] = [];
  if (cpu?.tempC !== undefined && cpu.tempC !== null) sensorCells.push(`CPU ${formatTemp(cpu.tempC)}`);
  if (gpu?.tempC !== undefined && gpu.tempC !== null) sensorCells.push(`GPU ${formatTemp(gpu.tempC)}`);
  if (temperature?.system !== undefined && temperature.system !== null)
    sensorCells.push(`SYS ${formatTemp(temperature.system)}`);
  for (const extra of temperature?.extras ?? []) {
    sensorCells.push(`${extra.label} ${formatTemp(extra.tempC)}`);
  }
  for (const fan of fans?.entries ?? []) {
    sensorCells.push(`${fan.label} ${formatRpm(fan.rpm)}`);
  }

  return (
    <div className="rb-card">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <span className="font-mono text-[15px] break-all">
          ws://{state.hostname}:{state.port}
        </span>
        <span className="rb-tiny text-secondary">
          {state.clients.length} device{state.clients.length === 1 ? "" : "s"} ·{" "}
          {state.samplesSent} samples · up {formatUptime(state.diagnostics?.uptimeSec)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-5">
        <MetricGauge
          label="CPU"
          percent={cpu?.usage}
          detail={
            cpu?.cores?.length
              ? `${cpu.cores.length} cores${cpu.tempC != null ? ` · ${formatTemp(cpu.tempC)}` : ""}`
              : undefined
          }
        />
        <MetricGauge
          label="Memory"
          percent={memory?.percent}
          detail={formatBytesPair(memory?.used, memory?.total)}
        />
        {gpu && (
          <MetricGauge
            label="GPU"
            percent={gpu.usage}
            detail={`${formatBytesPair(gpu.vramUsed, gpu.vramTotal)} VRAM${
              gpu.tempC != null ? ` · ${formatTemp(gpu.tempC)}` : ""
            }`}
          />
        )}
        {network && (
          <MetricStat
            label="Network"
            value={`${formatRate(network.rxBytesPerSec)} ↓ ${formatRate(network.txBytesPerSec)} ↑`}
            detail="receive / transmit"
          />
        )}
      </div>

      {sensorCells.length > 0 && (
        <div className="border-[3px] border-ink px-3 py-2 mt-4 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[14px]">
          {sensorCells.map((cell) => (
            <span key={cell}>{cell}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricGauge({
  label,
  percent,
  detail,
}: {
  label: string;
  percent?: number;
  detail?: string;
}) {
  const value = typeof percent === "number" ? Math.min(100, Math.max(0, percent)) : null;
  return (
    <div className="border-[3px] border-ink p-3">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <span className="rb-section">{label}</span>
        <span className="font-mono text-[15px]">{formatPercent(value)}</span>
      </div>
      <div className="rb-bar">
        <div className="rb-bar__fill" style={{ width: `${value ?? 0}%` }} />
      </div>
      {detail && <p className="rb-tiny text-secondary mt-2">{detail}</p>}
    </div>
  );
}

function MetricStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="border-[3px] border-ink p-3">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <span className="rb-section">{label}</span>
      </div>
      <p className="font-mono text-[15px] break-all">{value}</p>
      {detail && <p className="rb-tiny text-secondary mt-2">{detail}</p>}
    </div>
  );
}

function ConfigCard({
  form,
  onChange,
  onSave,
  saving,
}: {
  form: SetMonitorConfigParams;
  onChange: (form: SetMonitorConfigParams) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const screens = form.screens ?? [];
  const [customTokens, setCustomTokens] = useState<MetricToken[]>([]);
  const customId = makeScreenId(customTokens);

  const toggleScreen = (id: string) =>
    onChange({
      ...form,
      screens: screens.includes(id) ? screens.filter((s) => s !== id) : [...screens, id],
    });

  const toggleCustomToken = (token: MetricToken) =>
    setCustomTokens((prev) =>
      prev.includes(token) ? prev.filter((t) => t !== token) : [...prev, token]
    );

  const addCustomScreen = () => {
    if (!customId || screens.includes(customId) || screens.length >= MAX_SCREENS) return;
    onChange({ ...form, screens: [...screens, customId] });
    setCustomTokens([]);
  };

  const removeScreen = (id: string) => {
    const next = screens.filter((s) => s !== id);
    onChange({ ...form, screens: next.length > 0 ? next : ["clock"] });
  };

  const screenChips = (presets: { id: string; label: string }[]) => (
    <div className="flex flex-wrap gap-2 mt-1">
      {presets.map((preset) => {
        const on = screens.includes(preset.id);
        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={on}
            disabled={!on && screens.length >= MAX_SCREENS}
            onClick={() => toggleScreen(preset.id)}
            className="rb-chip"
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="rb-card">
      <p className="rb-h4 mb-5">Display configuration</p>

      <div className="grid grid-cols-2 gap-5">
        <NumberField
          label="Interval (ms)"
          value={form.intervalMs ?? 1000}
          min={250}
          max={10000}
          step={250}
          onChange={(v) => onChange({ ...form, intervalMs: v })}
        />
        <NumberField
          label="Rotate dwell (ms)"
          value={form.rotateMs ?? 5000}
          min={2000}
          max={60000}
          step={1000}
          onChange={(v) => onChange({ ...form, rotateMs: v })}
        />
        <NumberField
          label="Brightness (0-255)"
          value={form.brightness ?? 200}
          min={0}
          max={255}
          step={5}
          onChange={(v) => onChange({ ...form, brightness: v })}
        />
        <SelectField
          label="Timezone (POSIX TZ)"
          value={form.timezone ?? ""}
          options={[
            { value: "", label: "Device default (onboarding)" },
            ...TIMEZONE_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
          ]}
          onChange={(v) => onChange({ ...form, timezone: v })}
        />
      </div>

      <div className="mt-5">
        <span className="rb-label">Basic screens</span>
        {screenChips(BASIC_SCREENS)}
      </div>

      <div className="mt-5">
        <span className="rb-label">Custom screen</span>
        {screenChips(COMBO_SCREENS)}
        <p className="rb-helper mt-3 mb-1">Or pick metrics to build your own frame:</p>
        <div className="flex flex-wrap gap-2">
          {METRIC_TOKENS.map((token) => (
            <button
              key={token}
              type="button"
              aria-pressed={customTokens.includes(token)}
              onClick={() => toggleCustomToken(token)}
              className="rb-chip"
            >
              {METRIC_LABELS[token]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4 mt-3">
          <button
            type="button"
            className="rb-btn rb-btn--secondary rb-btn--sm"
            disabled={
              customTokens.length === 0 ||
              screens.includes(customId) ||
              screens.length >= MAX_SCREENS
            }
            onClick={addCustomScreen}
          >
            Add custom screen
          </button>
          <span className="rb-helper mt-0">
            {customTokens.length === 0
              ? "Build a frame from any combination."
              : screens.includes(customId)
                ? "That screen is already active."
                : `Preview: ${screenLabel(customId)}`}
          </span>
        </div>
      </div>

      <div className="mt-5">
        <span className="rb-label">
          Active screens ({screens.length}/{MAX_SCREENS})
        </span>
        {screens.length === 0 ? (
          <p className="rb-helper mt-1">
            No screens enabled — the active screen defaults to the clock.
          </p>
        ) : (
          <ol className="rb-list mt-1">
            {screens.map((id, index) => (
              <li key={id} className="rb-list-item flex items-center justify-between gap-4">
                <span>
                  {index + 1}. {screenLabel(id)}
                </span>
                <button
                  type="button"
                  className="rb-btn rb-btn--sm shrink-0"
                  onClick={() => removeScreen(id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
        <p className="rb-helper">
          Rotation dwell is the time each screen stays visible in the rotation.
        </p>
      </div>

      <div className="mt-6 flex justify-end">
        <button onClick={onSave} disabled={saving} className="rb-btn rb-btn--primary">
          {saving ? "Saving…" : "Apply"}
        </button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const id = fieldId(label);
  return (
    <div>
      <label className="rb-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rb-input"
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = fieldId(label);
  return (
    <div>
      <label className="rb-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="rb-input">
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function fieldId(label: string): string {
  return `rb-${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}
