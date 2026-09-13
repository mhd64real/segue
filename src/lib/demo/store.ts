import "server-only";
import type { Clock } from "@/lib/clock";
import { seedDemoData } from "@/lib/demo/seed";
import { createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";

// The owner shown in demo mode. example.com is reserved, so it never names a real account.
export const DEMO_OWNER_EMAIL = "demo@example.com";

const GLOBAL_KEY = Symbol.for("segue.demoStore");

type DemoGlobal = typeof globalThis & { [GLOBAL_KEY]?: Promise<Store> };

function createTravelClock() {
  let fixed: Date | null = null;
  const clock: Clock = { now: () => (fixed ? new Date(fixed) : new Date()) };
  const travelTo = (date: Date | null) => {
    fixed = date ? new Date(date) : null;
  };
  return { clock, travelTo };
}

async function createSeededStore(): Promise<Store> {
  const { clock, travelTo } = createTravelClock();
  const store = createMemoryStore({ clock });
  await seedDemoData({ store, now: new Date(), travelTo });
  return store;
}

// One seeded store per server process. It lives on globalThis so pages, Server Actions
// and routes share it and it survives hot reloads.
export function getDemoStore(): Promise<Store> {
  const holder = globalThis as DemoGlobal;
  if (!holder[GLOBAL_KEY]) {
    holder[GLOBAL_KEY] = createSeededStore().catch((error: unknown) => {
      delete holder[GLOBAL_KEY];
      throw error;
    });
  }
  return holder[GLOBAL_KEY];
}
