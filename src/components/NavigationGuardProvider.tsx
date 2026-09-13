"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import ConfirmDialog from "@/components/ConfirmDialog";
import { createNavigationGuard, type NavigationGuard } from "@/lib/navigation-guard";

// Null outside the dashboard shell: links there are never held.
const NavigationGuardContext = React.createContext<NavigationGuard | null>(null);

export function useNavigationGuard(): NavigationGuard | null {
  return React.useContext(NavigationGuardContext);
}

// Call from a form with its dirty flag. While true, GuardedLink navigation asks first and
// the browser confirms a reload, a tab close or a visit to another site.
export function useUnsavedChanges(unsaved: boolean): void {
  const guard = useNavigationGuard();
  React.useEffect(() => {
    if (!unsaved) {
      return;
    }
    const release = guard?.hold();
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      release?.();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [guard, unsaved]);
}

export default function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [target, setTarget] = React.useState<string | null>(null);
  const [guard] = React.useState(() => createNavigationGuard(setTarget));

  return (
    <NavigationGuardContext.Provider value={guard}>
      {children}
      <ConfirmDialog
        open={target !== null}
        title="Discard unsaved changes?"
        description="The changes on this page are not saved."
        confirmLabel="Discard"
        confirmColor="error"
        onConfirm={() => {
          if (target !== null) {
            router.push(target);
          }
          setTarget(null);
        }}
        onClose={() => setTarget(null)}
      />
    </NavigationGuardContext.Provider>
  );
}
