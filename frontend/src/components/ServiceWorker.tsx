"use client";

import { useEffect } from "react";

/**
 * Registers the app-shell service worker on load, for every page.
 *
 * It used to be registered only when a user enabled push on the Alerts page,
 * so the caching that makes repeat visits instant never ran for anyone who
 * hadn't turned on notifications. Registration is idempotent — the Alerts page
 * can still call register() for push and it resolves to this same worker.
 *
 * Renders nothing. Failure is swallowed: a browser without service-worker
 * support (or a hard-refresh that bypasses it) must degrade to the plain
 * network app, never to an error.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
    // Wait for load so registration never competes with first paint or the
    // initial data fetches for bandwidth.
    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);
  return null;
}
