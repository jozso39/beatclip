/** A problem the user can fix (bad argument, missing file); printed without a stack trace. */
export class CliError extends Error {}

/** Parses "1:07", "1:07.5", "1:02:03.25" or "67.5" into seconds. */
export function parseTime(text: string): number {
  const s = text.trim();
  if (!/^(\d+:)?(\d+:)?\d+(\.\d+)?$/.test(s)) throw new CliError(`not a time: "${text}" (use 1:07, 1:07.5 or 67.5)`);
  const parts = s.split(":").map(Number);
  if (parts.slice(1).some((p) => p >= 60)) throw new CliError(`not a time: "${text}" (seconds and minutes must be below 60)`);
  return parts.reduce((total, p) => total * 60 + p, 0);
}

/** Formats seconds as m:ss.xx (67.5 -> "1:07.50"). */
export function fmtTime(t: number, digits = 2): string {
  const sign = t < 0 ? "-" : "";
  const scale = 10 ** digits;
  const total = Math.round(Math.abs(t) * scale);
  const whole = Math.floor(total / scale);
  const frac = digits ? "." + String(total % scale).padStart(digits, "0") : "";
  return `${sign}${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}${frac}`;
}

/** "1:07.50 (67.50 s)": both spellings, so nobody converts by hand. */
export const fmtBoth = (t: number) => `${fmtTime(t)} (${t.toFixed(2)} s)`;

/** A stretch of time: "1:05.30–1:09.30". */
export const fmtSpan = (from: number, to: number) => `${fmtTime(from)}–${fmtTime(to)}`;

/** A signed distance in seconds: "+0.12 s", "-1.50 s". */
export const fmtDelta = (d: number) => `${d >= 0 ? "+" : "-"}${Math.abs(d).toFixed(2)} s`;

/** Rounds to 3 decimals so JSON output has no float noise. */
export const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** A file-name-safe local timestamp: 20260131-142503. */
export function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
