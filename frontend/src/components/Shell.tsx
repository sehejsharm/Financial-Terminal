"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity, BarChart3, Bell, Briefcase, Filter, Globe, Home, LayoutGrid,
  LogOut, Menu, Newspaper, Search, Shield, Sigma, Terminal, Waves, X,
} from "lucide-react";

import { api, token } from "@/lib/api";
import { useLiveStatus } from "@/lib/useLive";
import { cn } from "@/lib/utils";

import { CommandPalette } from "./CommandPalette";

const NAV = [
  { href: "/",          label: "Dashboard",  icon: Home },
  { href: "/terminal",  label: "Terminal",   icon: Terminal },
  { href: "/portfolio", label: "Portfolio",  icon: Briefcase },
  { href: "/screeners", label: "Screeners",  icon: Filter },
  { href: "/quant",     label: "Quant",      icon: Sigma },
  { href: "/workspace", label: "Workspace",  icon: LayoutGrid },
  { href: "/alerts",    label: "Alerts",     icon: Bell },
  { href: "/macro",     label: "Macro",      icon: Globe },
  { href: "/news",      label: "News",       icon: Newspaper },
  { href: "/sharks",    label: "Big Sharks", icon: Waves },
  { href: "/admin",     label: "Admin",      icon: Shield, adminOnly: true },
];

const ALERTS_SEEN_KEY = "mb_alerts_seen";

/**
 * App shell — sticky top bar + collapsible left nav + global Cmd/Ctrl+K
 * command palette. On <md viewports the sidebar becomes a hamburger drawer
 * so the dashboard/watchlists/movers stay usable on a phone (read-mostly).
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<{ username: string; role: string } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unseenAlerts, setUnseenAlerts] = useState(0);
  // Honest header badge: LIVE only when a panel on this page is actually
  // polling (useLive registry). Static pages show STATIC — no fake pulse.
  const { polling } = useLiveStatus();

  // Boot: verify token; bounce to /login if missing/invalid.
  useEffect(() => {
    if (!token.get()) { router.replace("/login"); return; }
    api.me()
      .then(setMe)
      .catch(() => { token.clear(); router.replace("/login"); });
  }, [router]);

  // Header bell: poll triggered-alert events, badge anything newer than the
  // last time the user opened the alerts page.
  useEffect(() => {
    if (!me) return;
    let alive = true;
    const check = () => {
      api.alertEvents().then((evs) => {
        if (!alive) return;
        const seen = Number(localStorage.getItem(ALERTS_SEEN_KEY) || 0);
        setUnseenAlerts(evs.filter((e) => Date.parse(e.ts) > seen).length);
      }).catch(() => {});
    };
    check();
    const id = setInterval(check, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [me]);

  function openAlerts() {
    localStorage.setItem(ALERTS_SEEN_KEY, String(Date.now()));
    setUnseenAlerts(0);
    router.push("/alerts");
  }

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

  // Close the mobile drawer on navigation.
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  function logout() { token.clear(); router.replace("/login"); }

  const navLinks = NAV
    .filter((n) => !n.adminOnly || me?.role === "master_admin")
    .map(({ href, label, icon: Icon }) => {
      const active = pathname === href || (href !== "/" && pathname.startsWith(href));
      return (
        <Link
          key={href}
          href={href}
          // Intent-based prefetch: the always-visible sidebar meant Next
          // eagerly RSC-prefetched every route on first paint. Prefetch
          // on hover/focus instead.
          prefetch={false}
          onMouseEnter={() => router.prefetch(href)}
          onFocus={() => router.prefetch(href)}
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
    });

  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-[220px_1fr]">
      {/* Side nav (desktop) */}
      <aside className="border-r border-line bg-bg2/60 sticky top-0 h-screen hidden md:flex flex-col">
        <div className="px-4 py-4 border-b border-line">
          <div className="text-amber font-bold tracking-[0.18em] text-base">MOTHERBOARD</div>
          <div className="label-xs mt-1">Terminal · v0.1</div>
        </div>
        <nav className="p-2 flex-1 flex flex-col gap-1 overflow-y-auto">{navLinks}</nav>
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

      {/* Mobile drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setMenuOpen(false)}>
          <div className="absolute inset-0 bg-black/60" />
          {/* w-[82vw] capped at 288px: at 375-414px viewports the fixed
              width clipped the wordmark and sign-out row. min-w-0 +
              truncate keep long usernames from overflowing. */}
          <div onClick={(e) => e.stopPropagation()}
               className="absolute left-0 top-0 bottom-0 w-[82vw] max-w-72 bg-bg2 border-r border-line p-3 flex flex-col gap-1 overflow-y-auto overflow-x-hidden">
            <div className="flex items-center justify-between gap-2 px-1 pb-3 border-b border-line mb-2 min-w-0">
              <span className="text-amber font-bold tracking-[0.14em] text-sm truncate">MOTHERBOARD</span>
              <button onClick={() => setMenuOpen(false)} className="text-mut shrink-0"><X size={16} /></button>
            </div>
            {navLinks}
            <button onClick={logout}
                    className="mt-auto flex items-center gap-2 px-3 py-2 text-mut text-sm min-w-0">
              <LogOut size={13} className="shrink-0" />
              <span className="truncate">Sign out ({me?.username ?? "—"})</span>
            </button>
          </div>
        </div>
      )}

      {/* min-w-0: grid children default to min-width auto and refuse to
          shrink, so wide tables clipped past the viewport at 1080-1280px
          instead of scrolling inside their own panels. */}
      <div className="flex flex-col min-w-0">
        {/* Top bar */}
        <header className="border-b border-line bg-bg/80 backdrop-blur sticky top-0 z-30">
          <div className="flex items-center gap-3 px-3 md:px-5 py-2.5">
            <button onClick={() => setMenuOpen(true)} className="md:hidden text-mut hover:text-txt">
              <Menu size={18} />
            </button>
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded border border-line bg-panel hover:border-amber text-sm text-mut transition-colors w-[420px] max-w-full min-w-0"
            >
              <Search size={14} />
              <span className="flex-1 text-left truncate">Search ticker, function, or run command…</span>
              <kbd className="hidden md:inline text-[10px] px-1.5 py-0.5 rounded border border-line2 text-mut">⌘K</kbd>
            </button>
            <div className="flex-1" />
            <button onClick={openAlerts} className="relative text-mut hover:text-amber" title="Alerts">
              <Bell size={15} />
              {unseenAlerts > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-red text-white text-[9px] flex items-center justify-center">
                  {unseenAlerts > 9 ? "9+" : unseenAlerts}
                </span>
              )}
            </button>
            <div
              className="hidden sm:flex items-center gap-2 text-[11px] text-mut"
              title={polling
                ? "Panels on this page auto-refresh while the tab is visible"
                : "No auto-refresh on this page — data loads on demand"}
            >
              <Activity size={12} className={polling ? "text-green animate-pulse" : "text-mut"} />
              {polling ? "LIVE" : "STATIC"}
            </div>
          </div>
        </header>

        <main className="p-3 md:p-5 animate-in min-w-0 max-w-full overflow-x-hidden">{me ? children : null}</main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
