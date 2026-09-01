import type { Metadata } from "next";

// Per-route title + og:url. The pages themselves are "use client" and cannot
// export metadata, so a thin server-component segment layout carries it. The
// title fills the root template ("%s · Motherboard Terminal") and og:url is
// resolved against metadataBase, so social shares point at the real page.
export const metadata: Metadata = {
  title: "Account",
  openGraph: { url: "/account" },
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return children;
}
