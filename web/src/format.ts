const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

export function formatValue(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-AU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Units glued to the number for symbols that read that way (°, %), spaced otherwise. */
export function withUnits(text: string, units: string): string {
  if (!units) return text;
  return /^[°%]/.test(units) ? `${text}${units}` : `${text} ${units}`;
}

const TZ = "Australia/Hobart";

export const formatLocal = (unixSeconds: number, opts: Intl.DateTimeFormatOptions = {}) =>
  new Date(unixSeconds * 1000).toLocaleString("en-AU", {
    timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...opts,
  });

export function formatAge(unixSeconds: number, now = Date.now() / 1000): string {
  const mins = Math.max(0, Math.round((now - unixSeconds) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ${mins % 60} min ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
