"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, BarChart3, Filter, Home, LogOut, Search, Terminal } from "lucide-react";

import { api, token } from "@/lib/api";
import { cn } from "@/lib/utils";

import { CommandPalette } from "./CommandPalette";

const NAV = [
  { href: "/",         label: "Dashboard",   icon: Home },
  { href: "/terminal", label: "Terminal",    icon: Terminal },
  { href: "/screeners",label: "Screeners",   icon: Filter },
];

/**
 * App shell — sticky top bar + collapsible left nav + global Cmd/Ctrl+K command palette.
 * Designed so every page feels like part of one product, not a Streamlit page reload.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<{ username: string; role: string } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Boot: verify token; bounce to /login if missing/invalid.
  useEffect(() => {
    if (!token.get()) { router.replace("/login"); return; }
    api.me()
      .then(setMe)
      .catch(() => { token.clear(); router.replace("/login"); });
  }, [router]);

  // Cmd/Ctrl+K → command palette
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function logout() { token.clear(); router.replace("/login"); }

  return (
    <div className="min-h-screen grid grid-cols-[220px_1fr]">
      {/* Side nav */}
      <aside className="border-r border-line bg-bg2/60 sticky top-0 h-screen flex flex-col">
        <div className="px-4 py-4 border-b border-line">
          <div className="text-amber font-bold tracking-[0.18em] text-base">MOTHERBOARD</div>
          <div className="label-xs mt-1">Terminal · v0.1</div>
        </div>
        <nav className="p-2 flex-1 flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== "/" && pathname.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded text-sm uppercase tracking-wider transition-colors",
                  active
                    ? "bg-panel2 text-amber border border-line2"
                    : "text-mut hover:text-txt hover:bg-panel border border-transparent",
                )}
              >
                <Icon size={14} strokeWidth={2} />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-line text-[11px] text-mut">
          <div className="flex items-center justify-between">
            <span>{me?.username ?? "—"}</span>
            <button onClick={logout} className="hover:text-amber" title="Sign out">
              <LogOut size={13} />
            </button>
          </div>
          <div className="opacity-70 mt-1">{me?.role ?? ""}</div>
        </div>
      </aside>

      <div className="flex flex-col">
        {/* Top bar */}
        <header className="border-b border-line bg-bg/80 backdrop-blur sticky top-0 z-30">
          <div className="flex items-center gap-3 px-5 py-2.5">
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded border border-line bg-panel hover:border-amber text-sm text-mut transition-colors w-[420px] max-w-full"
            >
              <Search size={14} />
              <span className="flex-1 text-left">Search ticker, function, or run command…</span>
              <kbd className="text-[10px] px-1.5 py-0.5 rounded border border-line2 text-mut">⌘K</kbd>
            </button>
            <div className="flex-1" />
            <div className="flex items-center gap-2 text-[11px] text-mut">
              <Activity size={12} className="text-green animate-pulse" />
              LIVE
            </div>
          </div>
        </header>

        <main className="p-5 animate-in">{me ? children : null}</main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
