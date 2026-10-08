import type { Metadata } from "next";

// A segment layout carries the metadata because the page itself is
// "use client" (it holds the complaint form) and a client component cannot
// export metadata. Indexable, unlike /set-password: a prospective user should
// be able to find our regulatory status and complaint process from a search
// engine without signing up.
export const metadata: Metadata = {
  title: "Disclosures",
  description:
    "Regulatory status, data sources and their limitations, conflicts of "
    + "interest, and how to raise a complaint.",
  alternates: { canonical: "/disclosures" },
  // Indexable on purpose: a prospective user should be able to find our
  // regulatory status and complaint process from a search engine without
  // signing up. The root layout defaults to noindex, so this opts back in.
  robots: { index: true, follow: true },
  openGraph: { url: "/disclosures" },
};

export default function DisclosuresLayout({ children }: {
  children: React.ReactNode;
}) {
  return children;
}
