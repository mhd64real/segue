import { readFileSync } from "node:fs";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DashboardError from "@/app/(dashboard)/error";
import DashboardLoading from "@/app/(dashboard)/loading";
import VideoNotFound from "@/app/(dashboard)/videos/[videoId]/not-found";
import VideosLoading from "@/app/(dashboard)/videos/loading";

// error.tsx and loading.tsx sit next to the dashboard layout, so a failing or slow page
// renders inside the shell instead of replacing it. A loading file only shows when a child
// of its own folder changes, so videos/ has one too. The video page's notFound() renders
// the not-found.tsx of its own segment, inside the shell, instead of the stock 404.

type ClickableProps = { children?: unknown; onClick?: () => void };

function findByText(node: unknown, text: string): ClickableProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByText(child, text);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isValidElement(node)) {
    return null;
  }
  const props = node.props as ClickableProps & Record<string, unknown>;
  if (props.children === text) {
    return props;
  }
  return findByText(Object.values(props), text);
}

describe("dashboard error boundary", () => {
  const errorInfo = () => ({
    error: new Error("Database error in list_videos: Ada Brand <ada@brand.example>"),
    reset: vi.fn(),
    retry: vi.fn(),
  });

  it("is a client component, as Next requires for error boundaries", () => {
    const source = readFileSync(new URL("./error.tsx", import.meta.url), "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
  });

  it("states that the page did not load, without the error text", () => {
    const markup = renderToStaticMarkup(createElement(DashboardError, errorInfo()));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("This page did not load.");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("Database error");
    expect(markup).not.toContain("ada@brand.example");
  });

  it("retries the route from Try again", () => {
    const info = errorInfo();
    const button = findByText(DashboardError(info) as ReactNode, "Try again");
    expect(button?.onClick).toBeTypeOf("function");
    button!.onClick!();
    expect(info.retry).toHaveBeenCalledTimes(1);
    expect(info.reset).not.toHaveBeenCalled();
  });
});

describe("video not found", () => {
  it("states that the video does not exist and links back to Videos", () => {
    const markup = renderToStaticMarkup(createElement(VideoNotFound));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("This video does not exist.");
    expect(markup).toMatch(/<a [^>]*href="\/videos"[^>]*>.*Videos<\/a>/);
    expect(markup).not.toContain("404");
  });
});

describe("dashboard loading state", () => {
  it("renders a labelled progress bar", () => {
    const markup = renderToStaticMarkup(createElement(DashboardLoading));
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Loading page"');
  });

  it("is the same for moves between the videos pages", () => {
    expect(VideosLoading).toBe(DashboardLoading);
  });
});
