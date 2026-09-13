export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(date: Date): void;
}

// A clock for tests and demo data. With stepMs set, every now() call moves time forward
// by that much so consecutive writes get distinct, ordered timestamps.
export function createManualClock(start: Date = new Date("2026-01-01T00:00:00.000Z"), stepMs = 0): ManualClock {
  let current = start.getTime();
  return {
    now() {
      const value = new Date(current);
      current += stepMs;
      return value;
    },
    advance(ms) {
      current += ms;
    },
    set(date) {
      current = date.getTime();
    },
  };
}
