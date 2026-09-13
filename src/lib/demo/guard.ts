// Demo mode runs the app on in-memory data. It is active only under `next dev` with
// SEGUE_DEMO=1. process.env.NODE_ENV is referenced literally so production bundles
// compile the check to false.

export const DEMO_ENV_VAR = "SEGUE_DEMO";

export function isDemoMode(): boolean {
  return process.env.NODE_ENV === "development" && process.env.SEGUE_DEMO === "1";
}

export class DemoModeNotAllowedError extends Error {
  constructor() {
    super(`${DEMO_ENV_VAR} is set outside development. Demo mode only runs with next dev.`);
    this.name = "DemoModeNotAllowedError";
  }
}

// Any non-empty SEGUE_DEMO outside development stops the server from starting.
export function assertDemoModeAllowed(): void {
  const flag = process.env.SEGUE_DEMO?.trim();
  if (flag && process.env.NODE_ENV !== "development") {
    throw new DemoModeNotAllowedError();
  }
}
