/**
 * Session expiry detection.
 *
 * Scans a Playwright storageState and reports per-service expiry status
 * based on auth cookie expiry timestamps. No network calls — cheap and fast.
 *
 * Status tiers:
 *   - "valid"         : at least one auth cookie with expiry > now + EXPIRING_SOON_MS
 *   - "expiring-soon" : auth cookies exist but the soonest expires within 3 days
 *   - "expired"       : all auth cookies are past their expiry
 *   - "session-only"  : auth cookies exist with no expiry (session cookies),
 *                       can't be judged from metadata alone — may still be valid
 *   - "unknown"       : no auth cookies were even detected for this service
 *
 * Caveats: cookie expiry is a LOCAL check. A server can invalidate cookies
 * server-side (password change, manual logout, security event) and the local
 * metadata will still claim they're valid. For authoritative checks, layer
 * session-probe.ts on top.
 */

import { detectAuth, type DetectedAuth } from "./service-detector.js";

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

interface StorageStateShape {
  cookies: Cookie[];
  origins?: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export type ExpiryStatus =
  | "valid"
  | "expiring-soon"
  | "expired"
  | "session-only"
  | "unknown";

export interface ServiceExpiry {
  service: string;
  status: ExpiryStatus;
  /** Unix seconds of soonest-expiring auth cookie (if any has an expiry) */
  soonestExpiry?: number;
  /** Days until soonest expiry (rounded) — negative if already expired */
  daysUntilExpiry?: number;
  /** Count of auth cookies scanned */
  authCookieCount: number;
}

const EXPIRING_SOON_WINDOW_SECS = 3 * 24 * 60 * 60; // 3 days

// Auth cookie patterns — kept in sync with service-detector.ts
// Duplicated to keep this module self-contained; update both if you change.
const AUTH_COOKIE_PATTERNS = [
  /session/i,
  /token/i,
  /^auth/i,
  /^sid$/i,
  /jwt/i,
  /access/i,
  /login/i,
  /^user/i,
  /account/i,
  /^sapisid$/i,
  /^ssid$/i,
  /^hsid$/i,
  /^apisid$/i,
  /credential/i,
  /identity/i,
  /^__session/i,
  /^connect\.sid$/i,
  /^next-auth/i,
  /^sb-.*-auth/i,
  /^privy/i,
];

const TRACKING_COOKIES = new Set([
  "_ga",
  "_gid",
  "_gat",
  "_fbp",
  "_fbc",
  "NID",
  "CONSENT",
  "1P_JAR",
  "AEC",
  "SOCS",
  "_gcl_au",
]);

function isAuthCookie(cookie: Cookie): boolean {
  if (TRACKING_COOKIES.has(cookie.name)) return false;
  return AUTH_COOKIE_PATTERNS.some((p) => p.test(cookie.name));
}

function normalizeDomain(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

// Rebuild the service-name -> domain-suffix mapping that service-detector uses.
// We need the reverse lookup: given a cookie's domain, which service does it
// belong to? Rather than duplicate the whole map, we use detectAuth() to figure
// out which services are present, then re-scan cookies ourselves.
import { SERVICE_DOMAINS } from "./service-detector.js";

function matchService(cookieDomain: string): string | null {
  const domain = normalizeDomain(cookieDomain);
  for (const [suffix, service] of SERVICE_DOMAINS) {
    if (domain === suffix || domain.endsWith("." + suffix)) {
      return service;
    }
  }
  return null;
}

/**
 * Check expiry status for every service detected in a storageState.
 * Input services (optional) restricts output to only those services.
 */
export function checkExpiry(
  storageState: unknown,
  services?: string[],
): ServiceExpiry[] {
  const state = storageState as StorageStateShape;
  if (!state?.cookies) return [];

  // Group auth cookies by service
  const serviceGroups = new Map<string, Cookie[]>();
  for (const cookie of state.cookies) {
    const service = matchService(cookie.domain);
    if (!service) continue;
    if (!isAuthCookie(cookie)) continue;
    if (services && !services.includes(service)) continue;
    if (!serviceGroups.has(service)) serviceGroups.set(service, []);
    serviceGroups.get(service)!.push(cookie);
  }

  const results: ServiceExpiry[] = [];
  const nowSecs = Math.floor(Date.now() / 1000);

  for (const [service, authCookies] of serviceGroups) {
    // Partition: cookies with real expiry vs session-only (expires === -1)
    const withExpiry = authCookies.filter((c) => c.expires > 0);
    const sessionOnly = authCookies.filter((c) => c.expires <= 0);

    if (withExpiry.length === 0 && sessionOnly.length > 0) {
      // Only session cookies — can't judge from metadata alone
      results.push({
        service,
        status: "session-only",
        authCookieCount: authCookies.length,
      });
      continue;
    }

    if (withExpiry.length === 0) {
      results.push({
        service,
        status: "unknown",
        authCookieCount: authCookies.length,
      });
      continue;
    }

    // Soonest expiry (min) tells us the effective session lifetime.
    // If even one critical auth cookie dies, the session is gone.
    const soonest = Math.min(...withExpiry.map((c) => c.expires));
    const daysUntilExpiry = Math.round((soonest - nowSecs) / (24 * 60 * 60));

    let status: ExpiryStatus;
    if (soonest <= nowSecs) {
      status = "expired";
    } else if (soonest - nowSecs < EXPIRING_SOON_WINDOW_SECS) {
      status = "expiring-soon";
    } else {
      status = "valid";
    }

    results.push({
      service,
      status,
      soonestExpiry: soonest,
      daysUntilExpiry,
      authCookieCount: authCookies.length,
    });
  }

  results.sort((a, b) => a.service.localeCompare(b.service));
  return results;
}

/**
 * Merge detected auth services with their expiry info.
 * Services with no auth cookies at all get status "unknown".
 */
export function enrichAuthWithExpiry(
  auth: DetectedAuth[],
  storageState: unknown,
): Array<DetectedAuth & { expiry: ServiceExpiry }> {
  const expiries = checkExpiry(
    storageState,
    auth.map((a) => a.service),
  );
  const expiryMap = new Map(expiries.map((e) => [e.service, e]));
  return auth.map((a) => ({
    ...a,
    expiry: expiryMap.get(a.service) ?? {
      service: a.service,
      status: "unknown" as ExpiryStatus,
      authCookieCount: 0,
    },
  }));
}

// Re-export for callers that only need the enriched type
export type AuthWithExpiry = DetectedAuth & { expiry: ServiceExpiry };
