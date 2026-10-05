"use client";

/** A link into the terminal that does NOT prefetch until you mean it.
 *
 *  Next prefetches every <Link> in the viewport by default. On the dashboard
 *  that is 41 tiles pointing at /terminal?t=…, and the measured cost was 36
 *  RSC prefetch requests on a single load for a route the user had not asked
 *  for and mostly will not visit.
 *
 *  Turning prefetch off outright would make the first click feel slow, so
 *  intent is the trigger instead: hovering or focusing a tile is a good
 *  predictor of clicking it, and by then there is time to fetch before the
 *  click lands. Same pattern the sidebar nav already uses.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";

export function TickerLink({ href, title, className, children }: {
  href: string;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <Link
      href={href}
      title={title}
      className={className}
      prefetch={false}
      onMouseEnter={() => router.prefetch(href)}
      onFocus={() => router.prefetch(href)}
    >
      {children}
    </Link>
  );
}
