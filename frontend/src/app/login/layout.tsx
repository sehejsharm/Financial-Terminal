import type { Metadata } from "next";

// Per-route title + og:url. The pages themselves are "use client" and cannot
// export metadata, so a thin server-component segment layout carries it. The
// title fills the root template ("%s · Motherboard Terminal") and og:url is
// resolved against metadataBase, so social shares point at the real page.
export const metadata: Metadata = {
  title: "Sign in",
  // Its own description, canonical and index opt-in. Four of the five public
  // URLs were serving the SAME root product pitch as their search snippet, so
  // they competed with each other on duplicate text and all three described a
  // product none of them shows.
  description:
    "Sign in to Motherboard Terminal with a passkey or a password.",
  alternates: { canonical: "/login" },
  robots: { index: true, follow: true },
  openGraph: { url: "/login" },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
