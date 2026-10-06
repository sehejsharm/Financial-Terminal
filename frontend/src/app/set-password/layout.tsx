import type { Metadata } from "next";

// noindex: this page is only ever reached from a one-time emailed link, and a
// search engine following one would both leak the token into an index and burn
// the single use before the recipient got there.
export const metadata: Metadata = {
  title: "Set your password",
  robots: { index: false, follow: false },
  openGraph: { url: "/set-password" },
};

export default function SetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
