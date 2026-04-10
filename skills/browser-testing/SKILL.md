---
name: browser-testing
description: Use when performing browser automation that involves multiple sessions, session isolation, dynamic SPA interaction where snapshot refs fail, cookie/localStorage manipulation across sessions, parallel browser agents, or network interception with browser_route. This skill adds value specifically for multi-session patterns and workarounds for common Playwright MCP pitfalls (stale refs, SPA clicking, file URLs). Don't use for basic single-page navigation that doesn't involve sessions or dynamic content issues.
version: 0.2.0
---

# Browser Testing with Playwright Sessions

Patterns for E2E testing using the playwright-sessions MCP server. This skill focuses on multi-session workflows and workarounds for common pitfalls — not basic navigation (Claude handles that fine without guidance).

## Testing workflow

1. **Create or restore a session** — see the `session-management` skill for which approach to use
2. **Navigate** — `browser_navigate({ url, sessionId })`
3. **Snapshot** — `browser_snapshot({ sessionId })` returns an accessibility tree with `[ref]` numbers
4. **Interact** — `browser_click({ ref: N })`, `browser_fill({ ref: N, value })`, `browser_type({ text })`
5. **Verify** — `browser_verify_text_visible`, `browser_evaluate`, `browser_take_screenshot`
6. **Close** — `session_close({ sessionId })` — no disk writes, clean teardown

## Clicking on dynamic pages (React, Next.js, SPAs)

This is the #1 source of test flakiness with the Playwright MCP. `browser_snapshot` refs expire the instant the DOM changes — and heavy SPAs re-render constantly.

**Symptom:** `browser_click({ ref: N })` fails with "ref not found" even though you just took a snapshot.

**Fix — use `browser_evaluate` with JS:**
```js
(() => {
  const btn = [...document.querySelectorAll('button')]
    .find(b => b.textContent?.includes('Continue'));
  if (btn) {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'clicked';
  }
  return 'not found';
})()
```

**For Google/OAuth account choosers** (particularly tricky because they use non-standard markup):
```js
(() => {
  const el = [...document.querySelectorAll('[role=button], div, li')]
    .find(e => e.textContent?.includes('user@example.com'));
  if (el) { el.click(); return 'clicked'; }
  return 'not found';
})()
```

After any JS click, always call `browser_snapshot` again to confirm navigation succeeded.

## Cookie and localStorage across sessions

Every session has fully isolated cookies and localStorage — modifying one session's storage never affects another.

```
browser_cookie_set({ name, value, domain, sessionId })
browser_cookie_get({ name, sessionId })
browser_localstorage_set({ key, value, sessionId })
browser_localstorage_get({ key, sessionId })
```

Cloned sessions inherit the source's cookies and localStorage at clone time. After cloning, the two sessions diverge — writes to one don't appear in the other.

## Parallel testing with multiple agents

When multiple agents (sub-agents, team members) need browsers simultaneously:

```
// Agent 1 — creates its own isolated session
session_create({ name: "agent1-test" })

// Agent 2 — creates its own isolated session
session_create({ name: "agent2-test" })
```

Each agent passes its `sessionId` to every browser tool call. Sessions are fully isolated — different cookies, different pages, different state. No cross-contamination even when running concurrently.

For auth-required parallel testing, each agent should `restoreFrom` the same saved session independently — they each get their own copy of the cookies.

## Network interception

Mock API responses with `browser_route`:
```
browser_route({ pattern: "**/api/users", status: 200, body: '{"users": []}', sessionId })
```

Inspect outbound requests with `browser_network_requests({ sessionId })`.

Routes are per-session — setting a route on one session doesn't affect others.

## Common pitfalls

| Problem | Cause | Fix |
|---------|-------|-----|
| `browser_click` ref not found | SPA re-rendered between snapshot and click | Use `browser_evaluate` with JS (see above) |
| Cookies not persisted after close | `session_close` never auto-saves (by design) | Call `session_save` explicitly before close if you need persistence |
| `file://` URLs fail in headless | Chrome security policy blocks local file access | Use `data:text/html,...` or a local HTTP server |
| Cookie not scoped correctly | Missing `domain` parameter | Always pass `domain` when setting cookies |
| Session idle-closed mid-test | Sessions auto-close after 5 min of inactivity | Keep sessions active, or increase `--idle-timeout` |
