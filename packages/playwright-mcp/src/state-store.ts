import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from "fs";
import { join } from "path";
import {
  detectAuth,
  mergeAuth,
  type DetectedAuth,
} from "./service-detector.js";
import { checkExpiry, type ServiceExpiry } from "./session-expiry.js";

export interface SavedState {
  name: string;
  storageState: object;
  lastUrl: string;
  savedAt: string;
  savedBy: string;
  auth?: DetectedAuth[];
}

export interface LockInfo {
  pid: number;
  acquiredAt: string;
  sessionId: string;
}

export interface LockStatus {
  locked: boolean;
  pid?: number;
  acquiredAt?: string;
  sessionId?: string;
  stale?: boolean;
}

export interface SavedStateInfo {
  name: string;
  lastUrl: string;
  savedAt: string;
  savedBy: string;
  filePath: string;
  auth?: DetectedAuth[];
  /** Per-service expiry status derived from cookie metadata (no network) */
  expiry?: ServiceExpiry[];
  lock: LockStatus;
}

const SESSION_ID = `pid-${process.pid}-${Date.now().toString(36)}`;
const LOCK_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM = process exists but we can't signal it (different user/permissions)
    // ESRCH = process does not exist
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

export class StateStore {
  private stateDir: string;
  private lockDir: string;
  private archiveDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.lockDir = join(stateDir, ".locks");
    this.archiveDir = join(stateDir, ".archived");
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
    if (!existsSync(this.lockDir)) {
      mkdirSync(this.lockDir, { recursive: true });
    }
    if (!existsSync(this.archiveDir)) {
      mkdirSync(this.archiveDir, { recursive: true });
    }
  }

  /**
   * Archive sessions older than `maxAgeDays`. Moves files (does NOT delete)
   * to `.archived/`. Returns the list of archived session names.
   *
   * Archival, not deletion, is the policy: user work should never be
   * silently destroyed, only moved out of the primary store.
   */
  archiveStale(maxAgeDays: number): string[] {
    if (!existsSync(this.stateDir)) return [];
    const files = readdirSync(this.stateDir).filter((f) => f.endsWith(".json"));
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const archived: string[] = [];

    for (const file of files) {
      // Skip special files like manifest.json — user-managed, not a session
      if (file === "manifest.json") continue;

      const path = join(this.stateDir, file);
      try {
        const data: SavedState = JSON.parse(readFileSync(path, "utf-8"));
        const savedAt = data.savedAt ? new Date(data.savedAt).getTime() : 0;
        if (savedAt > 0 && savedAt < cutoff) {
          // Skip if locked by a live process
          const lockStatus = this.getLockStatus(
            data.name || file.replace(".json", ""),
          );
          if (lockStatus.locked && !lockStatus.stale) continue;

          const dest = join(this.archiveDir, file);
          renameSync(path, dest);
          archived.push(data.name || file.replace(".json", ""));
        }
      } catch {
        // Corrupted or unreadable — leave alone
      }
    }

    return archived;
  }

  private filePath(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.stateDir, `${safe}.json`);
  }

  private lockPath(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.lockDir, `${safe}.lock`);
  }

  // ─── Lock Management ──────────────────────────────────────────────

  acquireLock(name: string): void {
    const status = this.getLockStatus(name);
    if (status.locked && !status.stale) {
      throw new Error(
        `Session "${name}" is locked by another process (PID: ${status.pid}, since: ${status.acquiredAt}). ` +
          `Use restoreFrom: "${name}" with a different session name to get a read-only copy of the cookies.`,
      );
    }
    // Clean stale lock if needed
    if (status.stale) {
      try {
        unlinkSync(this.lockPath(name));
      } catch {
        /* ignore */
      }
    }
    const lock: LockInfo = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      sessionId: SESSION_ID,
    };
    writeFileSync(this.lockPath(name), JSON.stringify(lock, null, 2));
  }

  releaseLock(name: string): void {
    // Only release if we own it
    const path = this.lockPath(name);
    if (!existsSync(path)) return;
    try {
      const lock: LockInfo = JSON.parse(readFileSync(path, "utf-8"));
      if (lock.pid === process.pid) {
        unlinkSync(path);
      }
    } catch {
      // If we can't read it, try to remove anyway
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  }

  getLockStatus(name: string): LockStatus {
    const path = this.lockPath(name);
    if (!existsSync(path)) return { locked: false };
    try {
      const lock: LockInfo = JSON.parse(readFileSync(path, "utf-8"));
      const alive = isPidAlive(lock.pid);
      const age = Date.now() - new Date(lock.acquiredAt).getTime();
      const stale = !alive || age > LOCK_MAX_AGE_MS;
      if (stale) {
        return {
          locked: false,
          pid: lock.pid,
          acquiredAt: lock.acquiredAt,
          sessionId: lock.sessionId,
          stale: true,
        };
      }
      return {
        locked: true,
        pid: lock.pid,
        acquiredAt: lock.acquiredAt,
        sessionId: lock.sessionId,
      };
    } catch {
      return { locked: false };
    }
  }

  isOurLock(name: string): boolean {
    const path = this.lockPath(name);
    if (!existsSync(path)) return false;
    try {
      const lock: LockInfo = JSON.parse(readFileSync(path, "utf-8"));
      return lock.pid === process.pid;
    } catch {
      return false;
    }
  }

  cleanStaleLocks(): number {
    if (!existsSync(this.lockDir)) return 0;
    let cleaned = 0;
    const files = readdirSync(this.lockDir).filter((f) => f.endsWith(".lock"));
    for (const file of files) {
      const path = join(this.lockDir, file);
      try {
        const lock: LockInfo = JSON.parse(readFileSync(path, "utf-8"));
        const alive = isPidAlive(lock.pid);
        const age = Date.now() - new Date(lock.acquiredAt).getTime();
        if (!alive || age > LOCK_MAX_AGE_MS) {
          unlinkSync(path);
          cleaned++;
        }
      } catch {
        // Corrupted lock file — remove it
        try {
          unlinkSync(path);
          cleaned++;
        } catch {
          /* ignore */
        }
      }
    }
    return cleaned;
  }

  // ─── State Persistence ────────────────────────────────────────────

  save(name: string, storageState: object, lastUrl: string): void {
    // Check if another process holds the lock
    const lockStatus = this.getLockStatus(name);
    if (lockStatus.locked && !this.isOurLock(name)) {
      throw new Error(
        `Cannot save "${name}" — locked by another process (PID: ${lockStatus.pid}). ` +
          `The other process will save its own state on close.`,
      );
    }

    // Load existing state to preserve manual auth tags
    const existing = this.load(name);
    const existingAuth = existing?.auth;

    // Auto-detect services from cookies
    const autoDetected = detectAuth(storageState);
    const auth = mergeAuth(autoDetected, existingAuth);

    const state: SavedState = {
      name,
      storageState,
      lastUrl,
      savedAt: new Date().toISOString(),
      savedBy: SESSION_ID,
      ...(auth.length > 0 ? { auth } : {}),
    };
    writeFileSync(this.filePath(name), JSON.stringify(state, null, 2));
  }

  load(name: string): SavedState | null {
    const path = this.filePath(name);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }

  delete(name: string): boolean {
    const path = this.filePath(name);
    if (!existsSync(path)) return false;
    // Also clean up any lock
    this.releaseLock(name);
    unlinkSync(path);
    return true;
  }

  /**
   * Add or update a manual auth tag on a saved session.
   */
  tagAuth(
    name: string,
    service: string,
    identity?: string,
    remove?: boolean,
  ): void {
    const state = this.load(name);
    if (!state) throw new Error(`No saved state found for "${name}".`);

    const auth = state.auth || [];

    if (remove) {
      state.auth = auth.filter((a) => a.service !== service);
    } else {
      const existing = auth.find((a) => a.service === service);
      if (existing) {
        existing.identity = identity || existing.identity;
        existing.manual = true;
        existing.detectedAt = new Date().toISOString();
      } else {
        auth.push({
          service,
          domain: "manual",
          ...(identity ? { identity } : {}),
          manual: true,
          detectedAt: new Date().toISOString(),
        });
      }
      state.auth = auth;
    }

    writeFileSync(this.filePath(name), JSON.stringify(state, null, 2));
  }

  listSaved(): SavedStateInfo[] {
    if (!existsSync(this.stateDir)) return [];
    const files = readdirSync(this.stateDir).filter((f) => f.endsWith(".json"));
    const results: SavedStateInfo[] = [];
    for (const file of files) {
      try {
        const path = join(this.stateDir, file);
        const data: SavedState = JSON.parse(readFileSync(path, "utf-8"));
        // Use filename as session name (not data.name) so that symlink aliases
        // (e.g. aryaa.json → gabriel-socials-comms.json) appear under their
        // own names rather than as duplicates of the canonical session.
        const sessionName = file.replace(".json", "");
        // Skip non-session files like manifest.json
        if (!data.storageState) continue;
        // Live-detect auth if the file predates the auth feature
        const auth = data.auth ?? detectAuth(data.storageState);
        const expiry = checkExpiry(
          data.storageState,
          auth.map((a) => a.service),
        );
        results.push({
          name: sessionName,
          lastUrl: data.lastUrl,
          savedAt: data.savedAt,
          savedBy: data.savedBy,
          filePath: path,
          auth,
          expiry,
          lock: this.getLockStatus(sessionName),
        });
      } catch {
        // Skip corrupted files
      }
    }
    return results;
  }
}
