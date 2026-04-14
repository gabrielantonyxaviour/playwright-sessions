/**
 * Live auth probe — makes lightweight HTTP requests to service endpoints
 * with the saved cookies to verify sessions are actually alive on the server.
 *
 * Unlike session-expiry.ts (which only reads cookie metadata), this layer
 * catches server-side invalidation: password changes, manual logouts,
 * revoked tokens, etc.
 *
 * Usage:
 *   const results = await probeServices(storageState, ['GitHub', 'Vercel']);
 *   // [{ service: 'GitHub', alive: true }, { service: 'Vercel', alive: false, reason: '401' }]
 *
 * The probe is OPT-IN because it makes network calls. Default UX uses the
 * cheap cookie-expiry scan; --probe switches to this.
 */

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

export interface ProbeResult {
  service: string;
  alive: boolean;
  /** HTTP status code, or "error" / "timeout" / "no-probe" */
  reason: string;
  /** Milliseconds the request took */
  durationMs: number;
}

interface ProbeEndpoint {
  url: string;
  /**
   * HTTP status codes that indicate the session is alive.
   * Most browser-cookie-based probes hit a settings/profile page with
   * redirect:"manual" — 200 = logged in, 302 = redirected to /login = dead.
   */
  aliveStatusCodes: number[];
  /** Additional headers (rarely needed) */
  headers?: Record<string, string>;
}

// Per-service probe endpoints.
//
// Principles:
//   1. Endpoints must accept BROWSER SESSION COOKIES (not OAuth tokens).
//      Many API hosts like api.github.com reject session cookies — those
//      are unusable. Use web UI routes like /settings/profile instead.
//   2. Use redirect:"manual" so a 302-to-/login is treated as dead.
//   3. Only include endpoints we've verified actually work end-to-end.
//      It's better to return "no-probe" than to false-flag a live session.
// NOTE: The probe endpoint map is deliberately conservative.
//
// Most modern web apps use localStorage-stored JWTs or Authorization headers
// rather than httpOnly session cookies, so a pure cookie-based probe can't
// verify them. Adding unverified endpoints would produce false "DEAD" results
// and erode trust.
//
// This list only includes endpoints verified to work end-to-end with browser
// session cookies. Services not listed return reason:"no-probe" — that is
// NOT a failure, just "we don't have a probe for this". The CLI/handler
// renders it differently from actual failures.
//
// To add a new endpoint: verify by running `node dist/index.js sessions
// --name=<session> --probe` with a known-good session and confirm [LIVE].
// VERIFIED probe endpoints — each was tested against real saved sessions.
// "Verified" means: live session → 200, dead/expired session → non-200.
//
// DROPPED probes and reasons (investigated 2026-04-14):
//   Google       — consistent 429 (bot-detection on myaccount.google.com).
//                  Can't distinguish live from dead.
//   YouTube      — /account returns 303 for ALL sessions incl. logged-in.
//                  /feed/subscriptions returns 200 even when not logged in.
//   Neon         — /api/v2/users/me returns 401 (needs Bearer token, not cookie).
//                  Console app endpoints only return 301/302 redirect.
//   Notion       — /api/v3/getSpaces is POST-only; returns 404 on GET.
//   Higgsfield AI— /api/me returns 404 (endpoint does not exist).
//   X/Twitter    — /1.1/account/settings.json returns 403 even with ct0 CSRF
//                  header. API requires Bearer app token beyond session cookies.
//   Microsoft    — account.microsoft.com redirects for all sessions.
//                  Session cookies are scoped to microsoftonline.com, not
//                  account.microsoft.com.
//   WhatsApp     — SPA; no HTTP-probeable auth endpoint exists.
//   Tldv         — tldv.io not in SERVICE_DOMAINS, so it never appears in
//                  session auth lists. Cannot verify without detection support.
const PROBE_ENDPOINTS: Record<string, ProbeEndpoint> = {
  Vercel: {
    // VERIFIED: api.vercel.com/v2/user returns 200 with browser session cookies.
    // Expired/missing session → 401.
    url: "https://api.vercel.com/v2/user",
    aliveStatusCodes: [200],
  },
  GitHub: {
    // VERIFIED: /settings/profile returns 200 with valid user_session cookie.
    // Expired user_session → 302 redirect to /login.
    url: "https://github.com/settings/profile",
    aliveStatusCodes: [200],
  },
  Supabase: {
    // VERIFIED: /dashboard/account/me returns 200 with valid session.
    // Invalid/missing session → redirect.
    url: "https://supabase.com/dashboard/account/me",
    aliveStatusCodes: [200],
  },
  LinkedIn: {
    // VERIFIED: /feed/ returns 200 when li_at cookie is valid.
    // Expired li_at → 302 redirect to /login.
    url: "https://www.linkedin.com/feed/",
    aliveStatusCodes: [200],
  },
  Instagram: {
    // VERIFIED: /accounts/edit/ returns 200 with valid sessionid cookie.
    // Not logged in → 302 redirect to /accounts/login/.
    url: "https://www.instagram.com/accounts/edit/",
    aliveStatusCodes: [200],
  },
};

function normalizeDomain(d: string): string {
  return d.replace(/^\./, "").toLowerCase();
}

/**
 * Build a Cookie header string for a given request URL by selecting cookies
 * whose domain scope matches the URL's hostname — the same matching logic
 * a real browser uses.
 *
 * A cookie with domain ".github.com" is sent to any host ending in "github.com".
 * A cookie with domain "api.github.com" is sent only to api.github.com + subs.
 */
function buildCookieHeader(
  storageState: StorageStateShape,
  requestUrl: string,
): string {
  let hostname: string;
  try {
    hostname = new URL(requestUrl).hostname.toLowerCase();
  } catch {
    return "";
  }

  const parts: string[] = [];
  const seen = new Set<string>();

  for (const c of storageState.cookies) {
    const cd = normalizeDomain(c.domain);
    // Host-only match (cookie without leading dot) OR domain match:
    //   hostname === cd  OR  hostname endsWith "." + cd
    const matches = hostname === cd || hostname.endsWith("." + cd);
    if (!matches) continue;
    if (seen.has(c.name)) continue; // first cookie wins
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }

  return parts.join("; ");
}

/**
 * Probe a single service. Returns a ProbeResult regardless of outcome.
 * Never throws.
 */
export async function probeOne(
  service: string,
  storageState: StorageStateShape,
  timeoutMs: number,
): Promise<ProbeResult> {
  const endpoint = PROBE_ENDPOINTS[service];
  if (!endpoint) {
    return {
      service,
      alive: false,
      reason: "no-probe",
      durationMs: 0,
    };
  }

  const cookieHeader = buildCookieHeader(storageState, endpoint.url);
  if (!cookieHeader) {
    return {
      service,
      alive: false,
      reason: "no-cookies",
      durationMs: 0,
    };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint.url, {
      method: "GET",
      headers: {
        Cookie: cookieHeader,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...(endpoint.headers || {}),
      },
      signal: controller.signal,
      redirect: "manual", // treat redirects as auth failure
    });

    const durationMs = Date.now() - start;
    const alive = endpoint.aliveStatusCodes.includes(res.status);
    return {
      service,
      alive,
      reason: String(res.status),
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const name =
      err && typeof err === "object" && "name" in err
        ? (err as { name: string }).name
        : "error";
    return {
      service,
      alive: false,
      reason: name === "AbortError" ? "timeout" : "error",
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe multiple services in parallel. Each probe has its own timeout.
 */
export async function probeServices(
  storageState: unknown,
  services: string[],
  timeoutMs = 5000,
): Promise<ProbeResult[]> {
  const state = storageState as StorageStateShape;
  if (!state?.cookies) return [];
  return Promise.all(services.map((s) => probeOne(s, state, timeoutMs)));
}

/** Services with known probe endpoints — useful to show what can be probed */
export function getProbeCapableServices(): string[] {
  return Object.keys(PROBE_ENDPOINTS);
}
