---
description: List all saved browser sessions with auth services, identities, and cookie expiry status
argument-hint: [session-name]
allowed-tools: [mcp__playwright__session_list_saved, Read]
---

# List Saved Sessions

Show all saved browser sessions from `~/.playwright-sessions/` with their detected services, user identities, and cookie expiry status.

## Instructions

1. Call `mcp__playwright__session_list_saved()` (without probe — fast, cookie-metadata only)
2. If the user passed a session name as $ARGUMENTS, filter to just that session
3. Present the results in a readable format:
   - Session name
   - Last URL
   - Each detected service with identity and expiry status
   - Highlight any `[EXPIRED]` services prominently
4. If any sessions have expired services, suggest which ones need re-authentication and how (create new session → login → session_save)
5. Show the total count at the end
