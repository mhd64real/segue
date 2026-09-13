import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DeleteVideoCard from "@/components/videos/DeleteVideoCard";
import { VIDEO_DELETE_BLOCKED } from "@/lib/videos/form";

vi.mock("@/app/(dashboard)/videos/actions", () => ({ deleteVideo: vi.fn() }));

const VIDEO_ID = "11111111-1111-4111-8111-111111111111";

function render(blocked: boolean) {
  const markup = renderToStaticMarkup(createElement(DeleteVideoCard, { videoId: VIDEO_ID, blocked }));
  const buttons = markup.match(/<button[^>]*>/g) ?? [];
  expect(buttons).toHaveLength(1);
  return { markup, button: buttons.join("") };
}

describe("DeleteVideoCard", () => {
  it("offers an enabled Delete button with no rule text when nothing blocks the delete", () => {
    const { markup, button } = render(false);
    expect(markup).toContain("Delete video</button>");
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(button).not.toContain("aria-describedby");
    expect(markup).not.toContain(VIDEO_DELETE_BLOCKED);
    expect(markup).not.toContain("cannot be deleted");
  });

  it("disables Delete and states why when a reply for one of its branches was sent", () => {
    const { markup, button } = render(true);
    expect(button).toMatch(/\sdisabled=""/);
    const describedBy = button.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(markup).toContain(`id="${describedBy}"`);
    expect(markup).toMatch(new RegExp(`id="${describedBy}"[^>]*>${VIDEO_DELETE_BLOCKED}<`));
    expect(markup).not.toContain("cannot be deleted");
  });
});
