import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoModeNotAllowedError, assertDemoModeAllowed, isDemoMode } from "@/lib/demo/guard";

beforeEach(() => {
  vi.stubEnv("SEGUE_DEMO", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isDemoMode", () => {
  it("is on only in development with SEGUE_DEMO=1", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEGUE_DEMO", "1");
    expect(isDemoMode()).toBe(true);
  });

  it("is off without the flag", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isDemoMode()).toBe(false);
    vi.stubEnv("SEGUE_DEMO", "");
    expect(isDemoMode()).toBe(false);
  });

  it("is off for any other flag value", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const value of ["0", "true", "yes", " 1", "1 "]) {
      vi.stubEnv("SEGUE_DEMO", value);
      expect(isDemoMode()).toBe(false);
    }
  });

  it("is off outside development even with the flag", () => {
    vi.stubEnv("SEGUE_DEMO", "1");
    for (const env of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(isDemoMode()).toBe(false);
    }
  });
});

describe("assertDemoModeAllowed", () => {
  it("allows the flag in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEGUE_DEMO", "1");
    expect(() => assertDemoModeAllowed()).not.toThrow();
  });

  it("allows production and test without the flag", () => {
    for (const env of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      vi.stubEnv("SEGUE_DEMO", undefined);
      expect(() => assertDemoModeAllowed()).not.toThrow();
      vi.stubEnv("SEGUE_DEMO", "   ");
      expect(() => assertDemoModeAllowed()).not.toThrow();
    }
  });

  it("throws for any flag value outside development", () => {
    for (const env of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      for (const value of ["1", "0", "true"]) {
        vi.stubEnv("SEGUE_DEMO", value);
        expect(() => assertDemoModeAllowed()).toThrow(DemoModeNotAllowedError);
      }
    }
  });
});
