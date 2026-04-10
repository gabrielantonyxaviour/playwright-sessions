#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SessionManager } from "./session-manager.js";
import { StateStore } from "./state-store.js";
import { buildToolDefinitions } from "./tools/index.js";
import { handleToolCall } from "./handlers/index.js";
import { probeServices } from "./session-probe.js";
import { readFileSync } from "fs";

// Parse CLI args
const args = process.argv.slice(2);

// ─── `sessions` subcommand ────────────────────────────────────────────────────
// Usage: playwright-sessions sessions [--dir=<path>]
if (args[0] === "sessions") {
  const dirArg = args.find((a) => a.startsWith("--dir="));
  const stateDir = dirArg
    ? dirArg.split("=")[1]
    : `${process.env.HOME}/.playwright-sessions`;
  const probe = args.includes("--probe");
  const probeFilter = args.find((a) => a.startsWith("--name="));
  const nameFilter = probeFilter ? probeFilter.split("=")[1] : undefined;

  const store = new StateStore(stateDir);
  let saved = await store.listSaved();
  if (nameFilter) saved = saved.filter((s) => s.name === nameFilter);

  if (saved.length === 0) {
    console.log(`No saved sessions in ${stateDir}`);
    console.log(`Use session_save inside Claude to save a session.`);
    process.exit(0);
  }

  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const GREEN = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const RED = "\x1b[31m";
  const RESET = "\x1b[0m";
  const CYAN = "\x1b[36m";

  function timeAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (mins > 0) return `${mins}m ago`;
    return "just now";
  }

  // Per-service expiry badge
  function expiryBadge(
    expiry: { status: string; daysUntilExpiry?: number } | undefined,
  ): string {
    if (!expiry) return "";
    switch (expiry.status) {
      case "valid":
        return expiry.daysUntilExpiry !== undefined
          ? ` ${GREEN}· valid (${expiry.daysUntilExpiry}d left)${RESET}`
          : ` ${GREEN}· valid${RESET}`;
      case "expiring-soon":
        return ` ${YELLOW}· expiring in ${expiry.daysUntilExpiry}d${RESET}`;
      case "expired":
        return ` ${RED}· EXPIRED${RESET}`;
      case "session-only":
        return ` ${DIM}· session cookie${RESET}`;
      default:
        return "";
    }
  }

  // Run HTTP probes in parallel if --probe is set
  const probeResultsBySession = new Map<
    string,
    Map<string, { alive: boolean; reason: string }>
  >();
  if (probe) {
    console.log(`${DIM}Probing live auth endpoints...${RESET}`);
    await Promise.all(
      saved.map(async (s) => {
        if (!s.auth || s.auth.length === 0) return;
        // Load the storageState for this session
        try {
          const data = JSON.parse(readFileSync(s.filePath, "utf-8"));
          const services = s.auth!.map((a) => a.service);
          const results = await probeServices(data.storageState, services);
          probeResultsBySession.set(
            s.name,
            new Map(results.map((r) => [r.service, r])),
          );
        } catch {
          /* skip unreadable sessions */
        }
      }),
    );
    console.log();
  }

  console.log(`\n${BOLD}Saved sessions${RESET} ${DIM}(${stateDir})${RESET}\n`);

  for (const s of saved) {
    const lockLabel = s.lock.locked
      ? s.lock.stale
        ? ` ${YELLOW}[stale lock]${RESET}`
        : ` ${RED}[locked by pid ${s.lock.pid}]${RESET}`
      : "";
    const ago = s.savedAt ? ` ${DIM}· ${timeAgo(s.savedAt)}${RESET}` : "";
    console.log(`  ${BOLD}${CYAN}${s.name}${RESET}${lockLabel}${ago}`);
    if (s.lastUrl) {
      console.log(`  ${DIM}└ ${s.lastUrl}${RESET}`);
    }
    if (s.auth && s.auth.length > 0) {
      const expiryMap = new Map((s.expiry ?? []).map((e) => [e.service, e]));
      const probeMap = probeResultsBySession.get(s.name);
      for (const a of s.auth) {
        const identity = a.identity ? ` ${DIM}— ${a.identity}${RESET}` : "";
        const exp = expiryBadge(expiryMap.get(a.service));
        let probeTag = "";
        if (probeMap) {
          const r = probeMap.get(a.service);
          if (r) {
            if (r.reason === "no-probe") {
              probeTag = ` ${DIM}[no probe available]${RESET}`;
            } else if (r.alive) {
              probeTag = ` ${GREEN}[LIVE]${RESET}`;
            } else {
              probeTag = ` ${RED}[DEAD ${r.reason}]${RESET}`;
            }
          }
        }
        console.log(
          `  ${GREEN}  ✓ ${a.service}${RESET}${identity}${exp}${probeTag}`,
        );
      }
    } else {
      console.log(`  ${DIM}  (no auth detected)${RESET}`);
    }
    console.log();
  }

  console.log(`${DIM}${saved.length} session(s) total${RESET}\n`);
  process.exit(0);
}
const headless = args.includes("--headless");
const browserArg = args.find((a) => a.startsWith("--browser="));
const browserType =
  (browserArg?.split("=")[1] as "chromium" | "firefox" | "webkit") ||
  "chromium";
const viewportArg = args.find((a) => a.startsWith("--viewport="));
const viewport = viewportArg
  ? {
      width: parseInt(viewportArg.split("=")[1].split("x")[0]),
      height: parseInt(viewportArg.split("=")[1].split("x")[1]),
    }
  : { width: 1280, height: 720 };
const idleArg = args.find((a) => a.startsWith("--idle-timeout="));
const idleTimeoutMs = idleArg
  ? parseInt(idleArg.split("=")[1]) * 1000
  : undefined;
const maxSessionsArg = args.find((a) => a.startsWith("--max-sessions="));
const maxSessions = maxSessionsArg
  ? parseInt(maxSessionsArg.split("=")[1])
  : undefined;

const channelArg = args.find((a) => a.startsWith("--channel="));
const channel = channelArg ? channelArg.split("=")[1] : undefined;

const archiveArg = args.find((a) => a.startsWith("--archive-after-days="));
const noArchive = args.includes("--no-archive");
const archiveAfterDays = noArchive
  ? 0
  : archiveArg
    ? parseInt(archiveArg.split("=")[1])
    : undefined;

const manager = new SessionManager({
  headless,
  browserType,
  channel,
  viewport,
  idleTimeoutMs,
  maxSessions,
  archiveAfterDays,
});

const server = new Server(
  { name: "playwright-sessions", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: buildToolDefinitions(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;
  try {
    const result = await handleToolCall(name, toolArgs || {}, manager);
    return { content: [{ type: "text", text: result }] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Cleanup on exit
process.on("SIGINT", async () => {
  await manager.closeAll();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await manager.closeAll();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
