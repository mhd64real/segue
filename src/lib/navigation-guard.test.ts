import { describe, expect, it, vi } from "vitest";
import { createNavigationGuard } from "@/lib/navigation-guard";

function navigationEvent() {
  return { preventDefault: vi.fn() };
}

describe("navigation guard", () => {
  it("lets navigation through while nothing is unsaved", () => {
    const confirm = vi.fn();
    const guard = createNavigationGuard(confirm);
    const event = navigationEvent();

    guard.intercept("/videos", event);

    expect(guard.isHeld()).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("cancels navigation while a form is unsaved and asks with the target", () => {
    const confirm = vi.fn();
    const guard = createNavigationGuard(confirm);
    const release = guard.hold();
    const event = navigationEvent();

    guard.intercept("/sponsorships", event);

    expect(guard.isHeld()).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledExactlyOnceWith("/sponsorships");

    release();
    const after = navigationEvent();
    guard.intercept("/sponsorships", after);
    expect(after.preventDefault).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("stays held until every unsaved form is released, and a second release changes nothing", () => {
    const guard = createNavigationGuard(vi.fn());
    const releaseEditor = guard.hold();
    const releaseOther = guard.hold();

    releaseEditor();
    releaseEditor();
    expect(guard.isHeld()).toBe(true);

    releaseOther();
    expect(guard.isHeld()).toBe(false);
  });
});
