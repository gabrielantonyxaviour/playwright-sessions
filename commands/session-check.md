---
description: Deep-check session health with live HTTP probes against service endpoints (slow — ~1-2s per session)
argument-hint: [session-name]
allowed-tools: [mcp__playwright__session_list_saved]
---

# Session Health Check

Run a deep health check on all saved sessions — includes live HTTP probes to verify server-side auth is actually alive (not just cookie metadata). This is slower than `/sessions` because it makes real HTTP requests.

## Instructions

1. Tell the user: "Running HTTP probes against live endpoints — this takes a few seconds per session."
2. Call `mcp__playwright__session_list_saved({ probe: true })`
3. If the user passed a session name as $ARGUMENTS, filter to just that session
4. Present results with both cookie expiry AND probe status:
   - `[valid, Nd left] [LIVE]` — cookies valid AND server confirms auth is alive
   - `[valid, Nd left] [no probe]` — cookies look good but no HTTP endpoint available to verify this service
   - `[EXPIRED] [DEAD 401]` — cookies expired AND server confirms dead
   - `[valid, Nd left] [DEAD 401]` — **dangerous**: cookies look valid locally but server says dead (silent server-side revocation)
5. Flag any services where cookie says valid but probe says DEAD — explain this means the server invalidated the session (password change, manual logout, security event) and the local cookie metadata can't detect it
6. Recommend specific re-authentication actions for expired/dead sessions
