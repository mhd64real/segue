"use client";

import * as React from "react";
import NextLink from "next/link";
import { useNavigationGuard } from "@/components/NavigationGuardProvider";

export type GuardedLinkProps = Omit<React.ComponentProps<typeof NextLink>, "href"> & { href: string };

// A Next Link that asks before leaving a page with unsaved changes. Use it (directly or as
// a MUI `component`) for links rendered next to an editor.
export default function GuardedLink({ href, onNavigate, ...props }: GuardedLinkProps) {
  const guard = useNavigationGuard();
  return (
    <NextLink
      {...props}
      href={href}
      onNavigate={(event) => {
        onNavigate?.(event);
        guard?.intercept(href, event);
      }}
    />
  );
}
