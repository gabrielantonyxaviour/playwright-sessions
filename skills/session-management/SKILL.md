---
name: session-management
description: Use when working with Playwright browser sessions — creating, cloning, saving, restoring, or closing sessions. Also use when checking session auth status, debugging expired logins, managing the saved session store, or when any mcp__playwright__session_* tool is about to be called. This skill should trigger whenever someone mentions "session expiry", "expired cookies", "re-authenticate", "save session", "clone session", "restore auth", "browser login persistence", or encounters an auth-related failure in a Playwright session. Use it proactively before session operations, not just reactively after failures.
version: 0.2.0
---

# Session Management

Correct usage of the playwright-sessions MCP tools. Following these patterns prevents the most common mistakes: polluted session stores, accidentally saved clones, and using expired auth that silently fails.

## Before any session work

**Always call `session_list_saved()` first.** It returns every saved session with:
- Detected services and identities (GitHub, Vercel, Google, etc.)
- Cookie expiry status per service: `[valid, Nd left]`, `[expiring-soon]`, `[EXPIRED]`, `[session cookie]`
- Lock status (whether another process is using it)

If a service shows `[EXPIRED]`, the saved cookies are dead — restoring that session won't give you working auth for that service. You'll need to re-login (Workflow C below).

Pass `{ probe: true }` for live HTTP validation against server endpoints. This is slow (~1-2s per session) and currently only Vercel's endpoint is verified, so most services show `[no probe]`. The cookie-based expiry check catches ~80% of issues without any network calls.

## Session creation rules

`session_create` is NOT a general-purpose "start testing" command when you need auth. Choosing the wrong approach leads to either missing cookies or polluted disk state.

| Scenario | What to do | Why |
|----------|-----------|-----|
| Stateless testing (no login needed) | `session_create({ name: "test-foo" })` — fresh, no cookies | Clean context, nothing to restore |
| Auth-required testing | `session_create({ name: "test-foo", restoreFrom: "saved-session-name" })` — loads saved cookies | Reuses existing login without touching the source |
| First-time login setup | `session_create({ name: "new-auth" })` → user logs in → `session_save()` | The only time `session_save` should be called on a new session |

## Clone lifecycle

Clones copy cookies from an **in-memory** session at a point in time. They exist because sometimes you need two browser contexts with the same auth simultaneously (e.g., parallel agents). They are throwaway — here's why each rule exists:

- `session_clone` creates an isolated copy — changes do NOT propagate back. This is intentional: the clone is a sandbox.
- **`session_save` on a clone THROWS an error.** This is enforced in the code (v0.2.0+) because saving clones was the #1 cause of session directory pollution — prior to v0.2.0, close auto-saved every named session, which filled `~/.playwright-sessions/` with 80+ test artifacts. The error message explains how to use `overwriteSource: true` if you genuinely need to update the source.
- **`session_close` does NOT write to disk.** Only explicit `session_save` persists state. This means closing a session is always safe — you can't accidentally pollute the store.
- **To refresh expired auth on a source session:** create with `restoreFrom`, re-login, then `session_save({ overwriteSource: true })` — this saves back to the source name, not a new file.

## Handling expired sessions

When `session_list_saved()` shows `[EXPIRED]` for a service you need:

1. The saved session still has cookies — they're just past their server-side expiry
2. Create a new session: `session_create({ name: "refresh-auth" })`
3. Navigate to the service's login page
4. User logs in (or use stored credentials if available)
5. `session_save()` — persist the fresh auth under this name
6. Or if updating an existing saved session: `session_create({ restoreFrom: "old-session" })`, re-login, then `session_save({ overwriteSource: true })`

## TTL archival

On MCP server start, sessions older than 30 days are automatically **moved** (not deleted) to `~/.playwright-sessions/.archived/`. A warning prints to stderr listing what was archived. This is a safety net — if a session was accidentally archived, it's recoverable. Disable with `--no-archive` or `--archive-after-days=0`.

## CLI

```bash
npx playwright-sessions sessions          # list all saved sessions with expiry
npx playwright-sessions sessions --probe  # + live HTTP validation
npx playwright-sessions sessions --name=my-session  # filter to one session
```
