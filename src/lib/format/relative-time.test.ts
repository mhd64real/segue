import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "@/lib/format/relative-time";

const NOW = new Date("2026-09-14T12:00:00.000Z");

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("says just now under a minute, in either direction", () => {
    expect(formatRelativeTime(NOW, NOW)).toBe("just now");
    expect(formatRelativeTime(ago(59_999), NOW)).toBe("just now");
    expect(formatRelativeTime(new Date(NOW.getTime() + 30_000), NOW)).toBe("just now");
  });

  it("uses the largest whole unit and rounds down", () => {
    expect(formatRelativeTime(ago(MINUTE), NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(ago(59 * MINUTE), NOW)).toBe("59 minutes ago");
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe("1 hour ago");
    expect(formatRelativeTime(ago(47 * HOUR), NOW)).toBe("1 day ago");
    expect(formatRelativeTime(ago(2 * DAY), NOW)).toBe("2 days ago");
    expect(formatRelativeTime(ago(13 * DAY), NOW)).toBe("1 week ago");
    expect(formatRelativeTime(ago(45 * DAY), NOW)).toBe("1 month ago");
    expect(formatRelativeTime(ago(800 * DAY), NOW)).toBe("2 years ago");
  });

  it("describes future times", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + 3 * HOUR), NOW)).toBe("in 3 hours");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatRelativeTime(new Date("nope"), NOW)).toBe("");
  });
});
