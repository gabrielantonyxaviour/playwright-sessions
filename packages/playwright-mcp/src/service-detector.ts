/**
 * Auto-detect authenticated services from a Playwright storageState.
 * Scans cookies and localStorage to identify which services are logged in
 * and attempts to extract user identity (email/username).
 */

export interface DetectedAuth {
  service: string;
  domain: string;
  identity?: string;
  manual?: boolean;
  detectedAt: string;
}

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

// ─── Service Domain Map ────────────────────────────────────────────
// [domainSuffix, serviceName]
export const SERVICE_DOMAINS: [string, string][] = [
  // Dev platforms
  ["github.com", "GitHub"],
  ["githubusercontent.com", "GitHub"],
  ["gitlab.com", "GitLab"],
  ["bitbucket.org", "Bitbucket"],
  ["vercel.com", "Vercel"],
  ["netlify.com", "Netlify"],
  ["railway.app", "Railway"],
  ["render.com", "Render"],
  ["heroku.com", "Heroku"],
  ["fly.io", "Fly.io"],
  ["cloudflare.com", "Cloudflare"],
  ["workers.dev", "Cloudflare"],
  ["pages.dev", "Cloudflare"],
  ["digitalocean.com", "DigitalOcean"],
  ["npmjs.com", "npm"],
  ["docker.com", "Docker"],
  ["hub.docker.com", "Docker Hub"],

  // Cloud providers
  ["aws.amazon.com", "AWS"],
  ["console.aws.amazon.com", "AWS"],
  ["azure.com", "Azure"],
  ["portal.azure.com", "Azure"],
  ["cloud.google.com", "Google Cloud"],

  // Google
  ["google.com", "Google"],
  ["googleapis.com", "Google"],
  ["youtube.com", "YouTube"],

  // Microsoft
  ["microsoft.com", "Microsoft"],
  ["microsoftonline.com", "Microsoft"],
  ["live.com", "Microsoft"],
  ["office.com", "Microsoft 365"],
  ["outlook.com", "Outlook"],

  // Social / messaging
  ["facebook.com", "Facebook"],
  ["instagram.com", "Instagram"],
  ["twitter.com", "X/Twitter"],
  ["x.com", "X/Twitter"],
  ["linkedin.com", "LinkedIn"],
  ["whatsapp.com", "WhatsApp"],
  ["web.whatsapp.com", "WhatsApp"],
  ["discord.com", "Discord"],
  ["slack.com", "Slack"],
  ["reddit.com", "Reddit"],
  ["telegram.org", "Telegram"],

  // Productivity
  ["notion.so", "Notion"],
  ["linear.app", "Linear"],
  ["figma.com", "Figma"],
  ["miro.com", "Miro"],
  ["airtable.com", "Airtable"],
  ["asana.com", "Asana"],
  ["trello.com", "Trello"],
  ["clickup.com", "ClickUp"],
  ["canva.com", "Canva"],

  // AI platforms
  ["openai.com", "OpenAI"],
  ["anthropic.com", "Anthropic"],
  ["huggingface.co", "Hugging Face"],
  ["replicate.com", "Replicate"],
  ["sarvam.ai", "Sarvam AI"],
  ["higgsfield.ai", "Higgsfield AI"],

  // Databases / infra
  ["supabase.com", "Supabase"],
  ["supabase.co", "Supabase"],
  ["neon.tech", "Neon"],
  ["planetscale.com", "PlanetScale"],
  ["mongodb.com", "MongoDB"],
  ["upstash.com", "Upstash"],

  // Payments / commerce
  ["stripe.com", "Stripe"],
  ["paypal.com", "PayPal"],
  ["shopify.com", "Shopify"],

  // Domains / hosting
  ["godaddy.com", "GoDaddy"],
  ["namecheap.com", "Namecheap"],
  ["cloudflare.com", "Cloudflare"],
  ["squarespace.com", "Squarespace"],

  // Media
  ["pexels.com", "Pexels"],
  ["unsplash.com", "Unsplash"],
  ["dribbble.com", "Dribbble"],

  // Email
  ["mailgun.com", "Mailgun"],
  ["sendgrid.com", "SendGrid"],
  ["resend.com", "Resend"],

  // Analytics / monitoring
  ["sentry.io", "Sentry"],
  ["datadog.com", "Datadog"],
  ["grafana.com", "Grafana"],
  ["posthog.com", "PostHog"],
  ["mixpanel.com", "Mixpanel"],
  ["amplitude.com", "Amplitude"],
];

// ─── Auth Cookie Patterns ──────────────────────────────────────────
// Cookies that indicate authentication (not just tracking)
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
  /^sb-.*-auth/i, // Supabase auth
  /^privy/i,
];

// Known tracking-only cookies to exclude
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

// ─── Identity Extraction ───────────────────────────────────────────
// Service-specific cookie names that contain identity
const IDENTITY_COOKIES: Record<string, string[]> = {
  GitHub: ["dotcom_user", "logged_in"],
  npm: ["npm_user"],
};

// Generic cookie name patterns for identity
const IDENTITY_COOKIE_PATTERNS = [
  /^user_?name$/i,
  /^user_?email$/i,
  /^email$/i,
  /^login$/i,
  /^display_?name$/i,
  /^account_?name$/i,
  /^dotcom_user$/i,
];

// localStorage key patterns for identity
const IDENTITY_LS_PATTERNS = [
  /email/i,
  /user_?name/i,
  /displayName/i,
  /profile/i,
  /currentUser/i,
  /account/i,
  /^user$/i,
];

// ─── Core Detection Logic ──────────────────────────────────────────

function normalizeDomain(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

function matchService(cookieDomain: string): string | null {
  const domain = normalizeDomain(cookieDomain);
  for (const [suffix, service] of SERVICE_DOMAINS) {
    if (domain === suffix || domain.endsWith("." + suffix)) {
      return service;
    }
  }
  return null;
}

function isAuthCookie(cookie: Cookie): boolean {
  if (TRACKING_COOKIES.has(cookie.name)) return false;
  return AUTH_COOKIE_PATTERNS.some((p) => p.test(cookie.name));
}

function tryDecodeJwt(value: string): Record<string, unknown> | null {
  try {
    const parts = value.split(".");
    if (parts.length !== 3) return null;
    // Only attempt if middle part looks base64-ish and reasonable length
    if (parts[1].length < 10 || parts[1].length > 4000) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    );
    if (typeof payload === "object" && payload !== null) return payload;
    return null;
  } catch {
    return null;
  }
}

function extractIdentityFromCookies(
  service: string,
  cookies: Cookie[],
): string | undefined {
  // 1. Check service-specific known cookies
  const knownNames = IDENTITY_COOKIES[service];
  if (knownNames) {
    for (const name of knownNames) {
      const cookie = cookies.find(
        (c) => c.name === name && c.value && c.value !== "yes",
      );
      if (cookie) return cookie.value;
    }
  }

  // 2. Check generic identity cookie patterns
  for (const cookie of cookies) {
    for (const pattern of IDENTITY_COOKIE_PATTERNS) {
      if (
        pattern.test(cookie.name) &&
        cookie.value &&
        cookie.value.length < 100
      ) {
        return cookie.value;
      }
    }
  }

  // 3. Try JWT decode on auth-looking cookies
  for (const cookie of cookies) {
    if (!isAuthCookie(cookie)) continue;
    const jwt = tryDecodeJwt(cookie.value);
    if (jwt) {
      const email =
        (jwt.email as string) ||
        (jwt.preferred_username as string) ||
        (jwt.name as string) ||
        (jwt.sub as string);
      if (email && typeof email === "string" && email.length < 100) {
        return email;
      }
    }
  }

  return undefined;
}

function extractIdentityFromLocalStorage(
  origin: string,
  entries: Array<{ name: string; value: string }>,
): string | undefined {
  for (const entry of entries) {
    // Check if key matches identity patterns
    const keyMatches = IDENTITY_LS_PATTERNS.some((p) => p.test(entry.name));
    if (!keyMatches) continue;

    // Try parsing as JSON to extract email/name
    try {
      const parsed = JSON.parse(entry.value);
      if (typeof parsed === "string" && parsed.includes("@")) return parsed;
      if (typeof parsed === "object" && parsed !== null) {
        const identity =
          parsed.email || parsed.username || parsed.name || parsed.displayName;
        if (identity && typeof identity === "string") return identity;
      }
    } catch {
      // Might be a plain string
      if (
        entry.value.includes("@") &&
        entry.value.length < 100 &&
        !entry.value.startsWith("{")
      ) {
        return entry.value;
      }
    }
  }

  return undefined;
}

// ─── Public API ────────────────────────────────────────────────────

export function detectAuth(storageState: unknown): DetectedAuth[] {
  const state = storageState as StorageStateShape;
  if (!state?.cookies) return [];

  // Group cookies by service
  const serviceGroups = new Map<
    string,
    { domain: string; cookies: Cookie[] }
  >();

  for (const cookie of state.cookies) {
    const service = matchService(cookie.domain);
    if (!service) continue;

    if (!serviceGroups.has(service)) {
      serviceGroups.set(service, {
        domain: normalizeDomain(cookie.domain),
        cookies: [],
      });
    }
    serviceGroups.get(service)!.cookies.push(cookie);
  }

  const results: DetectedAuth[] = [];
  const now = new Date().toISOString();

  for (const [service, group] of serviceGroups) {
    // Only include if at least one auth cookie exists
    const hasAuth = group.cookies.some((c) => isAuthCookie(c));
    if (!hasAuth) continue;

    // Try to extract identity from cookies
    let identity = extractIdentityFromCookies(service, group.cookies);

    // Try localStorage if cookie identity not found
    if (!identity && state.origins) {
      for (const origin of state.origins) {
        const originDomain = new URL(origin.origin).hostname;
        const originService = matchService(originDomain);
        if (originService === service && origin.localStorage.length > 0) {
          identity = extractIdentityFromLocalStorage(
            origin.origin,
            origin.localStorage,
          );
          if (identity) break;
        }
      }
    }

    results.push({
      service,
      domain: group.domain,
      ...(identity ? { identity } : {}),
      detectedAt: now,
    });
  }

  // Sort by service name for consistency
  results.sort((a, b) => a.service.localeCompare(b.service));

  return results;
}

/**
 * Merge auto-detected auth with existing manual tags.
 * Manual tags (manual: true) are preserved even if auto-detect no longer finds them.
 */
export function mergeAuth(
  autoDetected: DetectedAuth[],
  existing?: DetectedAuth[],
): DetectedAuth[] {
  if (!existing) return autoDetected;

  // Keep manual tags
  const manualTags = existing.filter((a) => a.manual);

  // Merge: auto-detected takes priority for non-manual entries
  const merged = [...autoDetected];

  for (const manual of manualTags) {
    // Don't duplicate if auto-detect found the same service
    const autoMatch = merged.find((a) => a.service === manual.service);
    if (autoMatch) {
      // Prefer manual identity if auto-detect didn't find one
      if (!autoMatch.identity && manual.identity) {
        autoMatch.identity = manual.identity;
      }
      autoMatch.manual = true;
    } else {
      merged.push(manual);
    }
  }

  return merged;
}
