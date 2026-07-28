"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity, Bell, Briefcase, Eye, Filter, Globe, Globe2, Home, LayoutGrid,
  LogOut, Menu, Moon, Newspaper, Search, Shield, Sigma, Sun, Terminal, Waves, X,
} from "lucide-react";

import { ApiError, api, token, type AlertEvent, type Quote } from "@/lib/api";
import { useLiveStatus } from "@/lib/useLive";
import { useStreamStatus } from "@/lib/useQuote";
import { cn, fmtPct } from "@/lib/utils";

import { CommandPalette } from "./CommandPalette";

/** Header data-status pill. Reflects the real socket when this page streams
 *  (LIVE / RECONNECTING / STALE / CLOSED via heartbeat), and falls back to
 *  the legacy polling indicator on pages not yet on the stream. */
function StreamBadge({ polling }: { polling: boolean }) {
  const { status } = useStreamStatus();
  const streaming = status === "live" || status === "reconnecting"
    || status === "stale" || status === "closed";

  const map = {
    live: { label: "LIVE", cls: "text-green animate-pulse", tip: "Streaming — ticks arriving live over the socket." },
    reconnecting: { label: "RECONNECTING", cls: "text-amber animate-pulse", tip: "Socket dropped — reconnecting with backoff." },
    stale: { label: "STALE", cls: "text-red", tip: "Connected but no ticks recently — feed may be paused." },
    closed: { label: "CLOSED", cls: "text-mut", tip: "Market is closed — showing the last session's values (honest, not faked)." },
  } as const;

  const s = streaming
    ? map[status as keyof typeof map]
    : polling
      ? { label: "LIVE", cls: "text-green animate-pulse", tip: "Panels on this page auto-refresh while the tab is visible." }
      : { label: "STATIC", cls: "text-mut", tip: "No auto-refresh on this page — data loads on demand." };

  return (
    <div className="hidden sm:flex items-center gap-2 text-[11px] text-mut" title={s.tip}>
      <Activity size={12} className={s.cls} />
      {s.label}
    </div>
  );
}

const NAV = [
  { href: "/",          label: "Dashboard",  icon: Home },
  { href: "/terminal",  label: "Terminal",   icon: Terminal },
  { href: "/portfolio", label: "Portfolio",  icon: Briefcase },
  { href: "/screeners", label: "Screeners",  icon: Filter },
  { href: "/quant",     label: "Quant",      icon: Sigma },
  { href: "/workspace", label: "Workspace",  icon: LayoutGrid },
  { href: "/alerts",    label: "Alerts",     icon: Bell },
  { href: "/global",    label: "Global",     icon: Globe2 },
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
  const [bellOpen, setBellOpen] = useState(false);
  const [bellEvents, setBellEvents] = useState<AlertEvent[]>([]);
  const [bellMoves, setBellMoves] = useState<{ ticker: string; chg: number }[]>([]);

  // Theme + colorblind-palette toggles (persisted; applied to <html> class).
  const [lightTheme, setLightTheme] = useState(false);
  const [cbPalette, setCbPalette] = useState(false);
  useEffect(() => {
    const light = localStorage.getItem("mb_theme") === "light";
    const cb = localStorage.getItem("mb_cb") === "1";
    setLightTheme(light); setCbPalette(cb);
    // Exclusive classes: "light" and "dark" must never coexist (the root
    // layout ships class="dark"; only adding "light" left both applied and
    // dark-mode CSS kept winning).
    document.documentElement.classList.toggle("light", light);
    document.documentElement.classList.toggle("dark", !light);
    document.documentElement.classList.toggle("cb", cb);
  }, []);
  function toggleTheme() {
    const next = !lightTheme;
    setLightTheme(next);
    localStorage.setItem("mb_theme", next ? "light" : "dark");
    document.documentElement.classList.toggle("light", next);
    document.documentElement.classList.toggle("dark", !next);
  }
  function toggleCb() {
    const next = !cbPalette;
    setCbPalette(next);
    localStorage.setItem("mb_cb", next ? "1" : "0");
    document.documentElement.classList.toggle("cb", next);
  }
  // Honest header badge: LIVE only when a panel on this page is actually
  // polling (useLive registry). Static pages show STATIC — no fake pulse.
  const { polling } = useLiveStatus();

  // Boot: verify the token, and bounce to /login ONLY when it is actually
  // rejected.
  //
  // This used to log the user out on ANY failure, including a timeout — which
  // apiFetch surfaces as status 0. A slow or briefly unreachable backend
  // therefore threw away a perfectly good session and dumped the user on the
  // sign-in screen. A network problem is not an authentication failure, so
  // transient errors are retried with a short backoff and the token is left
  // alone.
  useEffect(() => {
    if (!token.get()) { router.replace("/login"); return; }
    let alive = true;
    let attempt = 0;

    const verify = () => {
      api.me()
        .then((u) => { if (alive) setMe(u); })
        .catch((e: unknown) => {
          if (!alive) return;
          const status = e instanceof ApiError ? e.status : 0;
          if (status === 401 || status === 403) {
            token.clear();
            router.replace("/login");
            return;
          }
          // Transient (timeout, network, 5xx): keep the session and retry.
          if (attempt < 3) {
            attempt += 1;
            setTimeout(verify, attempt * 1500);
          }
        });
    };
    verify();
    return () => { alive = false; };
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

  // Bell dropdown: recent triggered alerts + watchlist movers (|chg| >= 2%).
  async function toggleBell() {
    const opening = !bellOpen;
    setBellOpen(opening);
    if (!opening) return;
    localStorage.setItem(ALERTS_SEEN_KEY, String(Date.now()));
    setUnseenAlerts(0);
    api.alertEvents().then((evs) => setBellEvents(evs.slice(0, 8))).catch(() => setBellEvents([]));
    try {
      const wls = await api.listWatchlists();
      const tickers = (wls[0]?.tickers ?? []).slice(0, 20);
      if (tickers.length) {
        const quotes = await api.quoteBulk(tickers);
        const moves = Object.entries(quotes)
          .map(([t, q]) => ({ ticker: t, chg: (q as Quote | null)?.change_pct ?? 0 }))
          .filter((m) => Math.abs(m.chg) >= 2)
          .sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg))
          .slice(0, 5);
        setBellMoves(moves);
      } else {
        setBellMoves([]);
      }
    } catch { setBellMoves([]); }
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
            <button onClick={toggleTheme} className="text-mut hover:text-amber"
                    title={lightTheme ? "Switch to dark theme" : "Switch to light theme"}>
              {lightTheme ? <Moon size={15} /> : <Sun size={15} />}
            </button>
            <button onClick={toggleCb}
                    className={cbPalette ? "text-amber" : "text-mut hover:text-amber"}
                    title={cbPalette ? "Colorblind-safe palette ON (blue=up, orange=down)" : "Enable colorblind-safe gain/loss colors"}>
              <Eye size={15} />
            </button>
            <div className="relative">
              <button onClick={toggleBell} className="relative text-mut hover:text-amber" title="Notifications">
                <Bell size={15} />
                {unseenAlerts > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-red text-white text-[9px] flex items-center justify-center">
                    {unseenAlerts > 9 ? "9+" : unseenAlerts}
                  </span>
                )}
              </button>
              {bellOpen && (
                <div className="absolute right-0 top-full mt-2 w-80 max-w-[90vw] panel-2 shadow-panel z-50 p-3"
                     onMouseLeave={() => setBellOpen(false)}>
                  <div className="label-xs mb-2">Triggered alerts</div>
                  {bellEvents.length === 0 && <div className="text-mut text-xs mb-2">Nothing fired recently.</div>}
                  {bellEvents.map((e, i) => (
                    <div key={i} className="text-xs py-1 border-b border-line/50 flex gap-2">
                      <span className="text-amber shrink-0">▲</span>
                      <span className="flex-1">{e.message}</span>
                    </div>
                  ))}
                  <div className="label-xs mt-3 mb-2">Watchlist moves (≥2%)</div>
                  {bellMoves.length === 0 && <div className="text-mut text-xs">No big moves in your watchlist.</div>}
                  {bellMoves.map((m) => (
                    <button key={m.ticker}
                            onClick={() => { setBellOpen(false); router.push(`/terminal?t=${encodeURIComponent(m.ticker)}`); }}
                            className="w-full flex justify-between text-xs py-1 hover:text-amber">
                      <span>{m.ticker}</span>
                      <span className={`num ${m.chg >= 0 ? "text-green" : "text-red"}`}>{fmtPct(m.chg)}</span>
                    </button>
                  ))}
                  <button onClick={() => { setBellOpen(false); router.push("/alerts"); }}
                          className="mt-3 w-full btn-ghost text-xs">
                    Open alert center →
                  </button>
                </div>
              )}
            </div>
            <StreamBadge polling={polling} />
          </div>
        </header>

        <main className="p-3 md:p-5 animate-in min-w-0 max-w-full overflow-x-hidden">{me ? children : null}</main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
