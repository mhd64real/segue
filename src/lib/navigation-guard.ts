// Holds client side navigation while a form on the page has unsaved changes. Links call
// `intercept` from their onNavigate handler; the provider asks the owner and navigates
// only after a confirm. Reloads and tab closes are covered by `beforeunload` instead.

export interface NavigationEventLike {
  preventDefault(): void;
}

export interface NavigationGuard {
  // Marks one form as unsaved. Returns the release function, which is safe to call twice.
  hold(): () => void;
  isHeld(): boolean;
  // While any form is unsaved: cancels the navigation and passes its target to `confirm`.
  intercept(href: string, event: NavigationEventLike): void;
}

export function createNavigationGuard(confirm: (href: string) => void): NavigationGuard {
  const holds = new Set<symbol>();
  return {
    hold() {
      const token = Symbol("unsaved");
      holds.add(token);
      return () => {
        holds.delete(token);
      };
    },
    isHeld() {
      return holds.size > 0;
    },
    intercept(href, event) {
      if (holds.size === 0) {
        return;
      }
      event.preventDefault();
      confirm(href);
    },
  };
}
