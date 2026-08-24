import { ConvexReactClient } from "convex/react";
import { api } from "../convex/_generated/api";

/**
 * First-party, privacy-friendly analytics.
 *
 * - No cookies, no fingerprinting, no PII.
 * - visitorId is a random UUID kept in localStorage (stable per browser).
 * - sessionId is a random UUID kept in sessionStorage (resets when the tab closes).
 * - The external referrer host is captured once per session only.
 * - All calls are fire-and-forget: analytics failures never affect the product.
 */

const client = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

let cachedVisitorId: string | null = null;
let referrerSentThisSession = false;

function getVisitorId(): string {
  if (cachedVisitorId) return cachedVisitorId;
  try {
    let id = window.localStorage.getItem("sp_vid");
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem("sp_vid", id);
    }
    cachedVisitorId = id;
    return id;
  } catch {
    return "anonymous";
  }
}

function getSessionId(): string {
  try {
    let id = window.sessionStorage.getItem("sp_sid");
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      window.sessionStorage.setItem("sp_sid", id);
    }
    return id;
  } catch {
    return `s-${Date.now().toString(36)}`;
  }
}

/** Coarse device category — deliberately not a fingerprint. */
function getDevice(): string {
  const w = window.innerWidth;
  if (/iPad|Tablet|Nexus 7/i.test(navigator.userAgent)) return "tablet";
  if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) return "mobile";
  if (w >= 640 && w < 1024 && "ontouchstart" in window) return "tablet";
  if (w < 640) return "mobile";
  return "desktop";
}

function externalReferrerOnce(): string | undefined {
  if (referrerSentThisSession) return undefined;
  referrerSentThisSession = true;
  try {
    const ref = document.referrer;
    if (!ref) return undefined;
    const host = new URL(ref).hostname;
    // Ignore internal navigation between SitePulse pages.
    if (host === window.location.hostname) return undefined;
    return host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export type EventProps = { targetUrl?: string; path?: string };

export function trackEvent(name: string, props: EventProps = {}): void {
  try {
    void client
      .mutation(api.analytics.track, {
        name,
        visitorId: getVisitorId(),
        sessionId: getSessionId(),
        path: props.path ?? window.location.pathname,
        device: getDevice(),
        referrer: name === "page_view" ? externalReferrerOnce() : undefined,
        targetUrl: props.targetUrl,
      })
      .catch(() => {
        /* analytics must never break the app */
      });
  } catch {
    /* analytics must never break the app */
  }
}

/** Track a page view for the given route path. */
export function trackPageView(path: string): void {
  trackEvent("page_view", { path });
}
