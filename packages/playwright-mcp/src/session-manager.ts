import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
  type BrowserType,
} from "playwright";
import { StateStore } from "./state-store.js";

export interface Session {
  id: string;
  name: string;
  context: BrowserContext;
  pages: Page[];
  activePageIndex: number;
  refs: Map<number, string>;
  nextRef: number;
  /** Async lock — only one operation per session at a time */
  lock: Promise<void>;
  releaseLock: (() => void) | null;
  /** Last time this session was used (Date.now()) */
  lastActivity: number;
  /** Session is marked dead and will be reaped */
  dead: boolean;
  /** Active network routes for this session */
  routes: Map<
    string,
    {
      pattern: string;
      handler: (...args: unknown[]) => unknown;
      status: number;
      body: string;
      contentType: string;
      headers?: Record<string, string>;
    }
  >;
  /** Whether tracing is currently active */
  tracingActive: boolean;
  /** True if this session was created via session_clone */
  isClone: boolean;
  /** Name of the source session this was cloned from (if isClone) */
  clonedFrom?: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  url: string;
  title: string;
  pageCount: number;
  isDefault: boolean;
  idleSeconds: number;
  dead: boolean;
}

export interface SessionManagerOptions {
  headless?: boolean;
  browserType?: "chromium" | "firefox" | "webkit";
  /** Browser channel: "chrome" = installed Chrome, "msedge" = installed Edge. Default: "chrome". */
  channel?: string;
  viewport?: { width: number; height: number };
  maxSessions?: number;
  /** Idle timeout in ms. Sessions with no activity are auto-closed. Default: 5 min. 0 = disabled. */
  idleTimeoutMs?: number;
  /** Directory for persistent session states. Default: ~/.playwright-sessions */
  stateDir?: string;
  /** Max age in days before a saved session is archived on startup. 0 = disabled. Default: 30. */
  archiveAfterDays?: number;
}

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const REAPER_INTERVAL_MS = 30 * 1000; // check every 30s
const DEFAULT_ARCHIVE_AFTER_DAYS = 30;

const DEFAULT_STATE_DIR = `${process.env.HOME}/.playwright-sessions`;

export class SessionManager {
  private browser: Browser | null = null;
  private browserLaunchPromise: Promise<Browser> | null = null;
  private sessions = new Map<string, Session>();
  private defaultSessionId: string | null = null;
  private options: Required<SessionManagerOptions>;
  private browserType: BrowserType;
  private reaperInterval: ReturnType<typeof setInterval> | null = null;
  /** Session names locked by this process */
  private lockedNames = new Set<string>();
  stateStore: StateStore;

  constructor(options: SessionManagerOptions = {}) {
    this.options = {
      headless: options.headless ?? false,
      browserType: options.browserType ?? "chromium",
      channel: options.channel ?? "chrome",
      viewport: options.viewport ?? { width: 1280, height: 720 },
      maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      stateDir: options.stateDir ?? DEFAULT_STATE_DIR,
      archiveAfterDays: options.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS,
    };

    this.stateStore = new StateStore(this.options.stateDir);

    const browserTypes = { chromium, firefox, webkit };
    this.browserType = browserTypes[this.options.browserType];

    // Archive stale saved sessions on startup (safety net against pollution).
    // Uses stderr so it doesn't corrupt the stdio JSON-RPC stream.
    if (this.options.archiveAfterDays > 0) {
      try {
        const archived = this.stateStore.archiveStale(
          this.options.archiveAfterDays,
        );
        if (archived.length > 0) {
          process.stderr.write(
            `[playwright-sessions] Archived ${archived.length} stale session(s) ` +
              `(older than ${this.options.archiveAfterDays} days) to ${this.options.stateDir}/.archived/: ` +
              archived.join(", ") +
              "\n",
          );
        }
      } catch (err) {
        process.stderr.write(
          `[playwright-sessions] TTL archival failed: ${(err as Error).message}\n`,
        );
      }
    }

    // Start the idle reaper if timeout is enabled
    if (this.options.idleTimeoutMs > 0) {
      this.reaperInterval = setInterval(
        () => this.reapIdleSessions(),
        REAPER_INTERVAL_MS,
      );
      // Don't let the reaper keep the process alive
      this.reaperInterval.unref();
    }
  }

  /**
   * Lazy browser init with mutex.
   * If two calls race, they share the same launch Promise — only one browser is created.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.browserLaunchPromise) {
      return this.browserLaunchPromise;
    }

    this.browserLaunchPromise = this.browserType
      .launch({
        headless: this.options.headless,
        // Use real installed Chrome, not "Google Chrome for Testing"
        // Real Chrome allows Gmail login and doesn't block features
        channel: this.options.channel || undefined,
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      })
      .then((browser) => {
        this.browser = browser;
        this.browserLaunchPromise = null;

        browser.on("disconnected", () => {
          this.browser = null;
          this.browserLaunchPromise = null;
          // Mark all sessions as dead
          for (const session of this.sessions.values()) {
            session.dead = true;
            session.pages = [];
          }
        });

        return browser;
      })
      .catch((err) => {
        this.browserLaunchPromise = null;
        throw err;
      });

    return this.browserLaunchPromise;
  }

  private generateId(): string {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /**
   * Reap idle and dead sessions. Runs on an interval.
   */
  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    const timeout = this.options.idleTimeoutMs;
    const toClose: string[] = [];

    for (const session of this.sessions.values()) {
      // Always reap dead sessions
      if (session.dead) {
        toClose.push(session.id);
        continue;
      }
      // Reap idle sessions (but never the default — it's the user's active session)
      if (session.id !== this.defaultSessionId) {
        const idle = now - session.lastActivity;
        if (idle >= timeout) {
          toClose.push(session.id);
        }
      }
    }

    for (const id of toClose) {
      await this.closeSession(id).catch(() => {});
    }

    // If all sessions are gone, close the browser too to free Chromium memory
    if (this.sessions.size === 0 && this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.browserLaunchPromise = null;
    }
  }

  /**
   * Touch a session's lastActivity timestamp. Call on every operation.
   */
  touchSession(session: Session): void {
    session.lastActivity = Date.now();
  }

  /**
   * Acquire exclusive lock on a session.
   * Returns a release function — MUST be called when the operation completes.
   */
  async acquireSessionLock(session: Session): Promise<() => void> {
    if (session.dead) {
      throw new Error(
        `Session "${session.name}" is dead (browser disconnected). Close it and create a new one.`,
      );
    }

    await session.lock;

    let releaseFn!: () => void;
    session.lock = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    session.releaseLock = releaseFn;

    return releaseFn;
  }

  /**
   * Derive an available session name when the requested one is locked.
   * Appends -2, -3, etc. until finding one that's not in use.
   */
  private deriveAvailableName(base: string): string {
    let n = 2;
    while (n < 100) {
      const candidate = `${base}-${n}`;
      const hasActive = [...this.sessions.values()].some(
        (s) => s.name === candidate,
      );
      const isLocked = this.stateStore.getLockStatus(candidate).locked;
      if (!hasActive && !isLocked) return candidate;
      n++;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  async createSession(
    name?: string,
    restore?: boolean,
    restoreFrom?: string,
  ): Promise<Session & { renamedFrom?: string }> {
    // Auto-reap dead sessions before checking limit
    await this.reapDeadSessions();

    if (this.sessions.size >= this.options.maxSessions) {
      throw new Error(
        `Session limit reached (${this.options.maxSessions}). Close unused sessions with session_close.`,
      );
    }

    if (name) {
      for (const s of this.sessions.values()) {
        if (s.name === name) {
          throw new Error(
            `Session name "${name}" already exists (id: ${s.id}). Use a different name or close the existing one.`,
          );
        }
      }
    }

    // Handle lock conflicts gracefully: if the name is locked by another process,
    // auto-derive a new name and restore cookies from the locked session.
    let renamedFrom: string | undefined;
    if (name) {
      const lockStatus = this.stateStore.getLockStatus(name);
      if (lockStatus.locked && !this.stateStore.isOurLock(name)) {
        // Locked by another process — use derived name, restore cookies from original
        renamedFrom = name;
        if (!restoreFrom) restoreFrom = name;
        name = this.deriveAvailableName(name);
      }
      this.stateStore.acquireLock(name);
      this.lockedNames.add(name);
    }

    // Determine which saved state to restore from
    let storageState: object | undefined;
    const restoreSource = restoreFrom || (restore && name ? name : undefined);
    if (restoreSource) {
      const saved = this.stateStore.load(restoreSource);
      if (saved) {
        storageState = saved.storageState;
      }
    }

    const browser = await this.ensureBrowser();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contextOptions: any = { viewport: this.options.viewport };
    if (storageState) contextOptions.storageState = storageState;
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const id = this.generateId();

    const session: Session & { renamedFrom?: string } = {
      id,
      name: name || id,
      context,
      pages: [page],
      activePageIndex: 0,
      refs: new Map(),
      nextRef: 1,
      lock: Promise.resolve(),
      releaseLock: null,
      lastActivity: Date.now(),
      dead: false,
      routes: new Map(),
      tracingActive: false,
      isClone: false,
      renamedFrom,
    };

    this.sessions.set(id, session);
    if (!this.defaultSessionId) {
      this.defaultSessionId = id;
    }

    return session;
  }

  async cloneSession(sourceId: string, name?: string): Promise<Session> {
    const source = this.getSession(sourceId);

    await this.reapDeadSessions();

    if (this.sessions.size >= this.options.maxSessions) {
      throw new Error(
        `Session limit reached (${this.options.maxSessions}). Close unused sessions with session_close.`,
      );
    }

    if (name) {
      for (const s of this.sessions.values()) {
        if (s.name === name) {
          throw new Error(
            `Session name "${name}" already exists (id: ${s.id}). Use a different name or close the existing one.`,
          );
        }
      }
    }

    const releaseSource = await this.acquireSessionLock(source);
    let storageState;
    try {
      storageState = await source.context.storageState();
    } finally {
      releaseSource();
    }

    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: this.options.viewport,
      storageState,
    });
    const page = await context.newPage();
    const id = this.generateId();

    const session: Session = {
      id,
      name: name || id,
      context,
      pages: [page],
      activePageIndex: 0,
      refs: new Map(),
      nextRef: 1,
      lock: Promise.resolve(),
      releaseLock: null,
      lastActivity: Date.now(),
      dead: false,
      routes: new Map(),
      tracingActive: false,
      isClone: true,
      clonedFrom: source.name,
    };

    this.sessions.set(id, session);
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);

    if (!session.dead) {
      await session.lock;
      // Stop tracing if active
      if (session.tracingActive) {
        await session.context.tracing.stop().catch(() => {});
        session.tracingActive = false;
      }
      // NOTE: No auto-save. Sessions are only persisted via explicit session_save.
      // Clones are throwaway by design — saving them on close (the pre-v0.2.0 behavior)
      // caused the saved-session directory to fill with polluted test runs.
      await session.context.close().catch(() => {});
    }

    // Release lock for this session name
    if (this.lockedNames.has(session.name)) {
      this.stateStore.releaseLock(session.name);
      this.lockedNames.delete(session.name);
    }

    this.sessions.delete(session.id);

    if (this.defaultSessionId === session.id) {
      const remaining = this.sessions.keys().next();
      this.defaultSessionId = remaining.done ? null : remaining.value;
    }
  }

  /**
   * Quickly reap only dead sessions (browser crashed).
   * Called before create/clone to free up slots.
   */
  private async reapDeadSessions(): Promise<void> {
    const toClose: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.dead) toClose.push(session.id);
    }
    for (const id of toClose) {
      this.sessions.delete(id);
      if (this.defaultSessionId === id) {
        const remaining = this.sessions.keys().next();
        this.defaultSessionId = remaining.done ? null : remaining.value;
      }
    }
  }

  setDefault(sessionId: string): void {
    const session = this.getSession(sessionId);
    this.defaultSessionId = session.id;
  }

  getSession(sessionId?: string): Session {
    const id = sessionId || this.defaultSessionId;
    if (!id) {
      throw new Error("No sessions exist. Create one with session_create.");
    }

    let session = this.sessions.get(id);
    if (!session) {
      for (const s of this.sessions.values()) {
        if (s.name === id) {
          session = s;
          break;
        }
      }
    }
    if (!session) {
      throw new Error(
        `Session "${id}" not found. Use session_list to see active sessions.`,
      );
    }
    return session;
  }

  getActivePage(session: Session): Page {
    if (session.dead) {
      throw new Error(
        `Session "${session.name}" is dead (browser disconnected). Close it and create a new one.`,
      );
    }

    session.pages = session.pages.filter((p) => !p.isClosed());
    if (session.pages.length === 0) {
      session.dead = true;
      throw new Error(
        `All pages in session "${session.name}" are closed. Create a new session.`,
      );
    }

    if (session.activePageIndex >= session.pages.length) {
      session.activePageIndex = session.pages.length - 1;
    }

    return session.pages[session.activePageIndex];
  }

  async listSessions(): Promise<SessionInfo[]> {
    const now = Date.now();
    const infos: SessionInfo[] = [];
    for (const session of this.sessions.values()) {
      try {
        if (session.dead) throw new Error("dead");
        const page = this.getActivePage(session);
        infos.push({
          id: session.id,
          name: session.name,
          url: page.url(),
          title: await page.title().catch(() => ""),
          pageCount: session.pages.length,
          isDefault: session.id === this.defaultSessionId,
          idleSeconds: Math.round((now - session.lastActivity) / 1000),
          dead: false,
        });
      } catch {
        infos.push({
          id: session.id,
          name: session.name,
          url: "(disconnected)",
          title: "",
          pageCount: 0,
          isDefault: session.id === this.defaultSessionId,
          idleSeconds: Math.round((now - session.lastActivity) / 1000),
          dead: true,
        });
      }
    }
    return infos;
  }

  async exportStorageState(sessionId?: string): Promise<object> {
    const session = this.getSession(sessionId);
    return session.context.storageState();
  }

  /**
   * Save a session's state to disk for persistence across Claude Code restarts.
   * Clones cannot be saved by default — they are throwaway by design.
   * Pass `overwriteSource: true` to intentionally overwrite the session this was cloned from.
   */
  async saveSession(
    sessionId?: string,
    overwriteSource = false,
  ): Promise<string> {
    const session = this.getSession(sessionId);

    // Guard: clones should not be saved as new named sessions.
    // The whole point of cloning is throwaway auth reuse.
    if (session.isClone) {
      if (!overwriteSource) {
        throw new Error(
          `Session "${session.name}" is a clone of "${session.clonedFrom}". ` +
            `Clones are throwaway by design — saving them pollutes the saved session store. ` +
            `If you intend to update the source auth, pass overwriteSource: true ` +
            `(this will save back to "${session.clonedFrom}", NOT create a new file).`,
        );
      }
      // Overwrite mode: save back to the source, not a new file
      const storageState = await session.context.storageState();
      let lastUrl = "about:blank";
      try {
        const page = this.getActivePage(session);
        lastUrl = page.url();
      } catch {
        /* no pages */
      }
      this.stateStore.save(session.clonedFrom!, storageState, lastUrl);
      return session.clonedFrom!;
    }

    const storageState = await session.context.storageState();
    let lastUrl = "about:blank";
    try {
      const page = this.getActivePage(session);
      lastUrl = page.url();
    } catch {
      /* no pages */
    }
    this.stateStore.save(session.name, storageState, lastUrl);
    return session.name;
  }

  async closeAll(): Promise<void> {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }

    for (const session of this.sessions.values()) {
      if (!session.dead) {
        // NOTE: No auto-save on shutdown. Only explicit session_save persists state.
        await session.context.close().catch(() => {});
      }
    }

    // Release all locks held by this process
    for (const name of this.lockedNames) {
      this.stateStore.releaseLock(name);
    }
    this.lockedNames.clear();

    this.sessions.clear();
    this.defaultSessionId = null;

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.browserLaunchPromise = null;
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
