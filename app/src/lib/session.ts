/**
 * US equities session, mirrored from DarwinOracle.isOpen (Chainlink "us_equities_24/5"): closed
 * from Saturday 00:00 UTC to Monday 01:00 UTC, open otherwise. Times in seconds (chain time).
 */
const DAY = 86_400;
const HOUR = 3_600;

export function usOpen(t: number): boolean {
  const weekday = (Math.floor(t / DAY) + 4) % 7; // 0 Sunday
  const hour = Math.floor((t % DAY) / HOUR);
  if (weekday === 6 || weekday === 0) return false;
  if (weekday === 1 && hour < 1) return false;
  return true;
}

/** When the session next changes: the next Saturday 00:00 UTC if open, the next Monday 01:00 UTC if closed. */
export function nextChange(t: number): number {
  const dayStart = Math.floor(t / DAY) * DAY;
  const weekday = (Math.floor(t / DAY) + 4) % 7;
  if (usOpen(t)) {
    const daysToSat = (6 - weekday + 7) % 7 || 7;
    return dayStart + daysToSat * DAY;
  }
  const daysToMon = (1 - weekday + 7) % 7;
  return dayStart + daysToMon * DAY + HOUR;
}

export function countdown(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / DAY);
  const h = Math.floor((seconds % DAY) / HOUR);
  const m = Math.floor((seconds % HOUR) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });
const hm = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
export const utcMoment = (t: number) => `${weekdayFmt.format(t * 1000)} ${hm.format(t * 1000)} UTC`;
