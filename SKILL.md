---
name: playwright-sessions
description: Use this skill whenever setting up Playwright browser sessions, managing saved auth state, debugging expired browser logins, cloning sessions for testing, or configuring the playwright-sessions MCP server. Also use when the user mentions "session management", "browser auth", "saved sessions", "cookie expiry", asks about persistent browser contexts, or wants to reuse a logged-in browser across Claude Code restarts. Even if the user doesn't mention "playwright-sessions" explicitly — if they're working with browser automation and need auth persistence, this skill applies.
version: 0.2.0
---

# Playwright Sessions

A session-aware Playwright MCP server that adds persistent named browser sessions on top of the official Playwright MCP. Fork of [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp).

## Install

Add to your MCP config (`.claude.json`, `.mcp.json`, or equivalent):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "playwright-sessions@latest"]
    }
  }
}
```

Or install as a Claude Code plugin: `/plugin install playwright-sessions`

## What this adds over the official Playwright MCP

The official `@playwright/mcp` starts fresh every time — no way to save a logged-in browser and reuse it later. This fork adds:

- **10 session tools** (`session_create`, `session_save`, `session_clone`, `session_list_saved`, etc.) alongside 25+ browser tools, all with optional `sessionId`
- **Save/restore auth** — persist cookies + localStorage to `~/.playwright-sessions/`, restore in future sessions
- **Cookie expiry detection** — `session_list_saved` shows per-service status (`[valid, 380d left]`, `[EXPIRED]`, `[session cookie]`) with zero network calls
- **Clone safety** — clones are throwaway by design; `session_save` on a clone throws unless `overwriteSource: true`
- **No auto-save on close** — only explicit `session_save` writes to disk (prevents session store pollution)
- **Optional HTTP probe** — `session_list_saved({ probe: true })` hits live endpoints to verify server-side auth
- **TTL archival** — sessions > 30 days auto-archived on server start
- **50+ service detection** — auto-detects GitHub, Google, Vercel, Neon, Supabase, Stripe, and more from cookies
- **CLI** — `npx playwright-sessions sessions` to inspect saved sessions from the terminal

## Quick reference

**Stateless testing:**
```
session_create({ name: "test-foo" })  →  work  →  session_close()
```

**Auth-required testing:**
```
session_list_saved()  →  check expiry  →  session_create({ name: "test", restoreFrom: "saved-auth" })  →  work  →  session_close()
```

**First-time login:**
```
session_create({ name: "github-login" })  →  user logs in  →  session_save()
```

**Check sessions from terminal:**
```bash
npx playwright-sessions sessions          # list with expiry badges
npx playwright-sessions sessions --probe  # + live HTTP validation
```

For detailed session management patterns, see the `session-management` skill. For browser testing best practices, see the `browser-testing` skill.
