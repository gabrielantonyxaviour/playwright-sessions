# playwright-sessions

> **Fork of [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)** — adds persistent named session management, live HTTP probes, cookie expiry detection, and clone safety on top of the official Playwright MCP.

[![npm version](https://img.shields.io/npm/v/playwright-sessions.svg)](https://www.npmjs.com/package/playwright-sessions)
[![license](https://img.shields.io/npm/l/playwright-sessions.svg)](https://github.com/gabrielantonyxaviour/playwright-sessions/blob/main/LICENSE)

## Why

The official `@playwright/mcp` starts fresh every time — no way to save a logged-in browser and reuse it later. This fork adds a **session layer**: named, persistent browser contexts that survive across Claude Code restarts.

**v0.3.0** makes session status authoritative: `session_list_saved` now runs real HTTP probes by default (cached 1 hour) to verify live server-side auth — not just cookie expiry metadata. LIVE/DEAD verdicts you can trust.

**v0.2.0** fixed the biggest footgun in browser session management: sessions that pollute your disk. Clones are throwaway by design (the code enforces it), close never auto-saves, and cookie expiry is detected without opening a browser.

## Install

### As an MCP server (Claude Code / any MCP client)

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

### As a Claude Code plugin

```
/plugin install playwright-sessions
```

## Tools

### Session tools (new)

| Tool | What it does |
|------|-------------|
| `session_create` | Create a named isolated browser context (optionally restore saved auth) |
| `session_list` | List all active sessions with URL, title, idle time |
| `session_clone` | Clone a session's cookies into a new throwaway context |
| `session_save` | Persist cookies + localStorage to `~/.playwright-sessions/` |
| `session_list_saved` | List saved sessions with services, identities, and **live HTTP probe status** (cached 1h) |
| `session_switch` | Change the default session |
| `session_close` | Destroy a session (no auto-save) |
| `session_storage_state` | Export raw storage state as JSON |
| `session_tag` | Manually label auth on a saved session |
| `session_delete_saved` | Delete a saved session from disk |

### Browser tools (25+)

All existing Playwright MCP browser tools (`browser_navigate`, `browser_click`, `browser_snapshot`, `browser_evaluate`, etc.) with an optional `sessionId` parameter for multi-session support.

## Key features

### Live HTTP probes (v0.3.0)

`session_list_saved` now runs real HTTP probes by default (results cached 1 hour):

```
GitHub (BonneyMantra)       [LIVE, probed just now]
Vercel (gabriel@example.com) [LIVE, probed 3m ago]
Supabase                    [LIVE, probed 3m ago]
LinkedIn                    [DEAD, 302]
Google                      [no-probe, cookie-valid 380d]
Microsoft                   [no-probe, session-cookie]
```

**Verified probe endpoints** (tested against real saved sessions):

| Service | Endpoint | LIVE signal | DEAD signal |
|---------|----------|------------|-------------|
| Vercel | `api.vercel.com/v2/user` | 200 | 401 |
| GitHub | `github.com/settings/profile` | 200 | 302 → /login |
| Supabase | `supabase.com/dashboard/account/me` | 200 | redirect |
| LinkedIn | `linkedin.com/feed/` | 200 | 302 → /login |
| Instagram | `instagram.com/accounts/edit/` | 200 | 302 → /accounts/login/ |

Services without a verified probe endpoint show `[no-probe, cookie-valid Nd]` (falls back to cookie metadata — same as v0.2.0 behavior).

Pass `{ probe: false }` to skip network calls and use cookie-metadata-only display.

### Cookie expiry detection (v0.2.0)

For services without live probe endpoints, `session_list_saved` falls back to cookie expiry status derived from metadata — no browser or network needed.

### Clone safety (v0.2.0)

Clones are throwaway by design:
- `session_save` on a clone **throws an error** with a clear message
- `session_close` **never auto-saves** to disk
- Pass `overwriteSource: true` to explicitly refresh the source session's auth

This prevents the most common problem with session management: a test directory filling up with 80+ saved test clones.

### TTL archival (v0.2.0)

Sessions older than 30 days are automatically **archived** (moved, not deleted) to `~/.playwright-sessions/.archived/` on server start. Configurable via `--archive-after-days=N` or disable with `--no-archive`.

### 50+ service detection

Auto-detects authenticated services from cookies: GitHub, Google, Vercel, Neon, Supabase, AWS, Stripe, Slack, Discord, LinkedIn, X/Twitter, and 40+ more. Extracts user identity where available (username, email).

## CLI

```bash
# List all saved sessions — runs live probes by default (cached 1h)
npx playwright-sessions sessions

# Skip probes, use cookie-metadata only
npx playwright-sessions sessions --probe=false

# Filter to a specific session
npx playwright-sessions sessions --name=gabriel-platforms
```

## Workflow

### Stateless testing (no login needed)

```
session_create({ name: "test-ui" })
browser_navigate({ url: "http://localhost:3000" })
browser_snapshot()
// ... test ...
session_close({ sessionId: "test-ui" })
// Nothing saved to disk
```

### Auth-required testing

```
session_list_saved()  // Shows LIVE/DEAD status per service (probed, cached 1h)
session_create({ name: "test-auth", restoreFrom: "my-saved-session" })
// Cookies are loaded — you're logged in
browser_navigate({ url: "https://dashboard.example.com" })
// ... test ...
session_close({ sessionId: "test-auth" })
// Original saved session untouched
```

### First-time login setup

```
session_create({ name: "github-login" })
// User logs in manually via the browser
session_save({ sessionId: "github-login" })
// Cookies persisted — restore in future sessions
```

## Server options

```bash
npx playwright-sessions@latest [options]

Options:
  --headless                 Run browser in headless mode
  --browser=chromium|firefox|webkit
  --channel=chrome|msedge    Use installed browser (default: chrome)
  --viewport=1280x720       Browser viewport size
  --idle-timeout=300         Seconds before idle sessions auto-close (default: 300)
  --max-sessions=20          Maximum concurrent sessions
  --archive-after-days=30    TTL for saved sessions (0 to disable)
  --no-archive               Disable TTL archival entirely
```

## Upstream issue

This work is tracked in [microsoft/playwright-mcp#1530](https://github.com/microsoft/playwright-mcp/issues/1530) as a feature request for the official package.

## License

Apache-2.0 (same as upstream)
