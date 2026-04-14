/**
 * Probe result cache — ~/.playwright-sessions/.probe-cache.json
 *
 * Caches per-service live/dead results for 1 hour so that
 * session_list_saved doesn't re-probe on every call.
 *
 * Cache shape:
 *   { [sessionName]: { probedAt: number, services: { [service]: { alive, reason } } } }
 *
 * TTL: 1 hour (3600s). After TTL, the entry is stale and must be re-probed.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_FILE = join(homedir(), ".playwright-sessions", ".probe-cache.json");
const TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ServiceProbeResult {
  alive: boolean;
  reason: string;
}

export interface SessionProbeCache {
  probedAt: number;
  services: Record<string, ServiceProbeResult>;
}

type ProbeCacheFile = Record<string, SessionProbeCache>;

function readCache(): ProbeCacheFile {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const raw = readFileSync(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as ProbeCacheFile;
  } catch {
    return {};
  }
}

function writeCache(cache: ProbeCacheFile): void {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // Non-fatal — cache write failure just means next call re-probes
  }
}

/**
 * Get a cached probe result for a session.
 * Returns null if no valid cache entry exists (absent or stale).
 */
export function getCachedProbe(sessionName: string): SessionProbeCache | null {
  const cache = readCache();
  const entry = cache[sessionName];
  if (!entry) return null;
  const ageMs = Date.now() - entry.probedAt;
  if (ageMs > TTL_MS) return null; // stale
  return entry;
}

/**
 * Store probe results for a session, keyed by service name.
 */
export function setCachedProbe(
  sessionName: string,
  services: Record<string, ServiceProbeResult>,
): void {
  const cache = readCache();
  cache[sessionName] = {
    probedAt: Date.now(),
    services,
  };
  writeCache(cache);
}

/**
 * How many minutes ago a cache entry was probed. Returns null if no entry.
 */
export function probedMinutesAgo(sessionName: string): number | null {
  const cache = readCache();
  const entry = cache[sessionName];
  if (!entry) return null;
  return Math.round((Date.now() - entry.probedAt) / 60000);
}
