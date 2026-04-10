import { readFileSync } from "fs";
import {
  setupPageListeners,
  withSession,
  consoleLogs,
  networkLogs,
} from "./shared.js";
import type { HandlerFn } from "./shared.js";
import { probeServices } from "../session-probe.js";

export const sessionHandlers = new Map<string, HandlerFn>([
  [
    "session_create",
    async (args, manager) => {
      const restore = args.restore as boolean | undefined;
      const restoreFrom = args.restoreFrom as string | undefined;
      const sessionName = args.name as string | undefined;
      const session = await manager.createSession(
        sessionName,
        restore,
        restoreFrom,
      );
      const page = manager.getActivePage(session);
      setupPageListeners(session.id, page);

      const renamedFrom = (session as { renamedFrom?: string }).renamedFrom;
      const effectiveRestoreFrom = renamedFrom || restoreFrom;
      const restoreSource =
        effectiveRestoreFrom ||
        (restore && sessionName ? sessionName : undefined);
      const restored = restoreSource
        ? manager.stateStore.load(restoreSource) !== null
        : false;

      const parts: string[] = [`Session "${session.name}" created.`];
      if (renamedFrom) {
        parts.push(
          `"${renamedFrom}" is in use by another process — auto-renamed to "${session.name}" with the same cookies.`,
        );
      }
      if (restored) {
        const src =
          effectiveRestoreFrom && effectiveRestoreFrom !== session.name
            ? ` from "${effectiveRestoreFrom}"`
            : "";
        parts.push(`Restored saved cookies${src}.`);
      }
      if (manager.sessionCount === 1) {
        parts.push("(set as default)");
      }

      return JSON.stringify({
        sessionId: session.id,
        name: session.name,
        ...(renamedFrom ? { renamedFrom } : {}),
        message: parts.join(" "),
      });
    },
  ],
  [
    "session_list",
    async (_args, manager) => {
      const sessions = await manager.listSessions();
      return JSON.stringify(sessions, null, 2);
    },
  ],
  [
    "session_clone",
    async (args, manager) => {
      const session = await manager.cloneSession(
        args.sourceSessionId as string,
        args.name as string | undefined,
      );
      const page = manager.getActivePage(session);
      setupPageListeners(session.id, page);
      return JSON.stringify({
        sessionId: session.id,
        name: session.name,
        message: `Session "${session.name}" cloned from "${args.sourceSessionId}" with same auth/cookies.`,
      });
    },
  ],
  [
    "session_close",
    async (args, manager) => {
      const sessionId = args.sessionId as string;
      await manager.closeSession(sessionId);
      consoleLogs.delete(sessionId);
      networkLogs.delete(sessionId);
      return `Session "${sessionId}" closed.`;
    },
  ],
  [
    "session_switch",
    async (args, manager) => {
      const session = manager.getSession(args.sessionId as string);
      manager.setDefault(session.id);
      return `Default session switched to "${session.name}" (${session.id}).`;
    },
  ],
  [
    "session_storage_state",
    async (args, manager) => {
      const sid = args.sessionId as string | undefined;
      return withSession(manager, sid, async (session) => {
        const state = await session.context.storageState();
        return JSON.stringify(state, null, 2);
      });
    },
  ],
  [
    "session_save",
    async (args, manager) => {
      const sid = args.sessionId as string | undefined;
      const overwriteSource = args.overwriteSource as boolean | undefined;
      const savedName = await manager.saveSession(sid, overwriteSource);
      return `Session "${savedName}" state saved to disk. Restore it in a future session with: session_create({ name: "${savedName}", restore: true })`;
    },
  ],
  [
    "session_list_saved",
    async (args, manager) => {
      manager.stateStore.cleanStaleLocks();
      const saved = manager.stateStore.listSaved();
      if (saved.length === 0) {
        return JSON.stringify([]);
      }

      // Optional: run HTTP probes to verify live server-side auth
      const probe = args.probe as boolean | undefined;
      const probeResultsBySession = new Map<
        string,
        Map<string, { alive: boolean; reason: string }>
      >();
      if (probe) {
        await Promise.all(
          saved.map(async (s) => {
            if (!s.auth || s.auth.length === 0) return;
            try {
              const data = JSON.parse(readFileSync(s.filePath, "utf-8"));
              const services = s.auth.map((a) => a.service);
              const results = await probeServices(data.storageState, services);
              probeResultsBySession.set(
                s.name,
                new Map(results.map((r) => [r.service, r])),
              );
            } catch {
              /* skip unreadable */
            }
          }),
        );
      }

      const formatted = saved.map((s) => {
        const expiryMap = new Map((s.expiry ?? []).map((e) => [e.service, e]));
        const probeMap = probeResultsBySession.get(s.name);
        const authSummary = s.auth?.length
          ? s.auth.map((a) => {
              const id = a.identity ? ` (${a.identity})` : "";
              const tag = a.manual ? " [manual]" : "";
              const exp = expiryMap.get(a.service);
              let expTag = "";
              if (exp) {
                if (exp.status === "valid") {
                  expTag = ` [valid, ${exp.daysUntilExpiry}d left]`;
                } else if (exp.status === "expiring-soon") {
                  expTag = ` [expiring in ${exp.daysUntilExpiry}d]`;
                } else if (exp.status === "expired") {
                  expTag = ` [EXPIRED]`;
                } else if (exp.status === "session-only") {
                  expTag = ` [session cookie]`;
                }
              }
              let probeTag = "";
              if (probeMap) {
                const r = probeMap.get(a.service);
                if (r) {
                  if (r.reason === "no-probe") {
                    probeTag = " [no probe]";
                  } else if (r.alive) {
                    probeTag = " [LIVE]";
                  } else {
                    probeTag = ` [DEAD ${r.reason}]`;
                  }
                }
              }
              return `${a.service}${id}${tag}${expTag}${probeTag}`;
            })
          : [];
        const lockLabel = s.lock.locked
          ? `LOCKED by PID ${s.lock.pid} since ${s.lock.acquiredAt}`
          : "available";
        return {
          name: s.name,
          lastUrl: s.lastUrl,
          savedAt: s.savedAt,
          services: authSummary,
          lock: lockLabel,
        };
      });
      return JSON.stringify(formatted, null, 2);
    },
  ],
  [
    "session_tag",
    async (args, _manager) => {
      _manager.stateStore.tagAuth(
        args.name as string,
        args.service as string,
        args.identity as string | undefined,
        args.remove as boolean | undefined,
      );
      const action = args.remove ? "Removed" : "Tagged";
      const identity = args.identity ? ` (${args.identity})` : "";
      return `${action} "${args.service}"${identity} on saved session "${args.name}".`;
    },
  ],
  [
    "session_delete_saved",
    async (args, manager) => {
      const deleted = manager.stateStore.delete(args.name as string);
      return deleted
        ? `Saved state "${args.name}" deleted.`
        : `No saved state found for "${args.name}".`;
    },
  ],
]);
