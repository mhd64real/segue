"use client";

import Button, { type ButtonProps } from "@mui/material/Button";
import GuardedLink from "@/components/GuardedLink";

// A stock Button that navigates with the Next router and asks first when the page has unsaved
// changes. Server Components can render it.
export default function LinkButton({ href, ...props }: Omit<ButtonProps<"a">, "href"> & { href: string }) {
  return <Button {...props} component={GuardedLink} href={href} />;
}
