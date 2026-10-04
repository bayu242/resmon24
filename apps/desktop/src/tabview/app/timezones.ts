// Curated POSIX TZ options for the desktop config picker. The device portal
// ships the same core list (see apps/firmware/src/NetworkManager.cpp).

export interface TimezoneOption {
  value: string;
  label: string;
}

export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { value: "UTC", label: "UTC" },
  { value: "WIB-7", label: "WIB-7 (Western Indonesia)" },
  { value: "WITA-8", label: "WITA-8 (Central Indonesia)" },
  { value: "WIT-9", label: "WIT-9 (Eastern Indonesia)" },
  { value: "SGT-8", label: "SGT-8 (Singapore)" },
  { value: "JST-9", label: "JST-9 (Tokyo)" },
  { value: "IST-5:30", label: "IST-5:30 (India)" },
  { value: "GMT+7", label: "GMT+7" },
  { value: "GMT+8", label: "GMT+8" },
  { value: "KST-9", label: "KST-9 (Korea)" },
  { value: "AEST-10", label: "AEST-10 (Australia East)" },
  { value: "NZST-12", label: "NZST-12 (New Zealand)" },
  { value: "MSK-3", label: "MSK-3 (Moscow)" },
  { value: "GMT0", label: "GMT0 (London)" },
  { value: "CET-1CEST,M3.5.0,M10.5.0/3", label: "Europe Central (CET)" },
  { value: "EST5EDT,M3.2.0,M11.1.0", label: "US Eastern (EST5EDT)" },
  { value: "CST6CDT,M3.2.0,M11.1.0", label: "US Central (CST6CDT)" },
  { value: "MST7MDT,M3.2.0,M11.1.0", label: "US Mountain (MST7MDT)" },
  { value: "PST8PDT,M3.2.0,M11.1.0", label: "US Pacific (PST8PDT)" },
  { value: "HST10", label: "HST10 (Hawaii)" },
];
