import { assertDemoModeAllowed } from "@/lib/demo/guard";

// Runs once when a server instance starts. Throwing here keeps a production server
// from serving requests with the demo flag set.
export function register(): void {
  assertDemoModeAllowed();
}
