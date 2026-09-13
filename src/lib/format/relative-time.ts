const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 365 * DAY_MS],
  ["month", 30 * DAY_MS],
  ["week", 7 * DAY_MS],
  ["day", DAY_MS],
  ["hour", HOUR_MS],
  ["minute", MINUTE_MS],
];

const formatter = new Intl.RelativeTimeFormat("en", { numeric: "always" });

// "just now", "5 minutes ago", "2 days ago", "in 3 hours". The locale is fixed and the
// caller passes `now`, so a server render and the client show the same text. Counts
// round down, so 47 hours is "1 day ago".
export function formatRelativeTime(date: Date, now: Date): string {
  const diff = date.getTime() - now.getTime();
  if (!Number.isFinite(diff)) {
    return "";
  }
  const distance = Math.abs(diff);
  for (const [unit, size] of UNITS) {
    if (distance >= size) {
      const value = Math.floor(distance / size);
      return formatter.format(diff < 0 ? -value : value, unit);
    }
  }
  return "just now";
}
