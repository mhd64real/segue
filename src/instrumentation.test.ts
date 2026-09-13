import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";
import { DemoModeNotAllowedError } from "@/lib/demo/guard";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("instrumentation register", () => {
  it("refuses to start a production server with SEGUE_DEMO set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SEGUE_DEMO", "1");
    expect(() => register()).toThrow(DemoModeNotAllowedError);
    expect(() => register()).toThrow("SEGUE_DEMO is set outside development");
  });

  it("starts a production server without the flag", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SEGUE_DEMO", undefined);
    expect(() => register()).not.toThrow();
  });

  it("starts the development server in demo mode", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEGUE_DEMO", "1");
    expect(() => register()).not.toThrow();
  });
});
