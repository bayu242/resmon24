// mDNS advertising for the resmon24 desktop monitor.
//
// Advertises a `_resmon24._tcp` service so ESP8266 devices (and browsers that
// browse DNS-SD) can discover the monitor without a manually entered IP. Loaded
// lazily and defensively: if the platform or dependency is unavailable the
// monitor still runs, just without advertising to devices.

import os from "node:os";

export interface Advertiser {
  stop(): void;
}

export interface AdvertiseOptions {
  port: number;
  protocolVersion: number;
  onError?: (message: string) => void;
}

export async function advertiseMonitor(options: AdvertiseOptions): Promise<Advertiser | null> {
  try {
    const mod: any = await import("bonjour-service");
    const BonjourCtor = mod.Bonjour ?? mod.default;
    const bonjour = new BonjourCtor();

    const service = bonjour.publish({
      name: `resmon24-${os.hostname()}`,
      type: "resmon24",
      port: options.port,
      txt: {
        proto: String(options.protocolVersion),
        host: os.hostname(),
        id: os.hostname().slice(0, 32),
      },
    });

    service?.on?.("error", (err: unknown) => options.onError?.(String(err)));

    return {
      stop() {
        try {
          service?.stop?.();
          bonjour.destroy?.();
        } catch {
          // best-effort teardown
        }
      },
    };
  } catch (error) {
    options.onError?.(`mDNS disabled: ${String(error)}`);
    return null;
  }
}
