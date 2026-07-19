#!/usr/bin/env bun
/**
 * prediff CLI. Commands per ARCHITECTURE.md §1:
 *   open [range] | status | comments | wait | resolve | refresh | stop
 * All support --json. All exit immediately except `wait` (bounded long-poll).
 *
 * Agent-facing rule: draft comments are never shown here — they belong to
 * the reviewer until sent (spec §4.2).
 */

import type { OpenResult, ReviewComment, StatusResult, WaitResult } from "../types";
import { CliError, api, ensureDaemon, findDaemon, requireRepoRoot } from "./client";
import { pidAlive } from "../server/lockfile";

const COMMANDS = new Set(["open", "status", "comments", "wait", "resolve", "refresh", "stop", "help"]);

const COMMENT_STATES: ReadonlySet<string> = new Set([
  "submitted",
  "addressed",
  "resolved",
  "orphaned",
]);

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let i = 0;
  // Human shortcut: `prediff` / `prediff <commit-ish>` behaves like `open`.
  const command = argv[0] !== undefined && COMMANDS.has(argv[0]) ? argv.shift()! : "open";
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (FLAGS_WITH_VALUE.has(name) && next !== undefined && !next.startsWith("--")) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, true);
        }
      }
    } else {
      positional.push(arg);
    }
    i++;
  }
  return { command, positional, flags };
}

const FLAGS_WITH_VALUE = new Set(["timeout", "reply", "ttl", "scope", "scope-files", "state"]);

function out(json: boolean, value: unknown, human: (v: never) => string): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(human(value as never));
  }
}

async function requireDaemon(repoRoot: string) {
  const lock = await findDaemon(repoRoot);
  if (!lock) {
    throw new CliError("no prediff daemon running for this repo (run `prediff open` first)");
  }
  return lock;
}

// ---------------------------------------------------------------------------
// Commands

async function cmdOpen(args: ParsedArgs): Promise<number> {
  const json = args.flags.has("json");
  const range = args.positional[0] ?? "working";
  const scopeFlag = args.flags.get("scope");
  const scopeFilesFlag = args.flags.get("scope-files");
  if (scopeFilesFlag === true) {
    throw new CliError('--scope-files requires a value (comma-separated globs, e.g. "src/lib/**,src/routes/users.ts")');
  }
  // Comma-separated glob patterns; stored on the session. When present the
  // UI flags exactly the files matching no pattern (heuristic disabled).
  const scopeFiles =
    typeof scopeFilesFlag === "string"
      ? scopeFilesFlag
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p !== "")
      : null;
  const root = await requireRepoRoot();
  const ttlFlag = args.flags.get("ttl");
  const lock = await ensureDaemon(root, {
    range,
    ...(typeof ttlFlag === "string" ? { ttlS: Number(ttlFlag) } : {}),
  });
  const result = await api<OpenResult>(lock, "/api/open", {
    method: "POST",
    body: JSON.stringify({
      range,
      ...(typeof scopeFlag === "string" ? { scope: scopeFlag } : {}),
      ...(scopeFiles !== null ? { scope_files: scopeFiles } : {}),
    }),
  });
  out(json, result, (r: OpenResult) =>
    [
      `prediff session ${r.session_id} (revision ${r.revision})`,
      `  ${r.url}`,
      `  ${r.files} file(s), +${r.additions} -${r.deletions}`,
    ].join("\n"),
  );
  if (!json && !args.flags.has("no-browser") && !process.env["PREDIFF_NO_BROWSER"]) {
    Bun.spawn(["open", result.url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  }
  return 0;
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const json = args.flags.has("json");
  const lock = await requireDaemon(await requireRepoRoot());
  const status = await api<StatusResult>(lock, "/api/status");
  out(json, status, (s: StatusResult) =>
    [
      `session ${s.session_id}  range=${s.range}  revision=${s.revision}  state=${s.session_state}`,
      `  ${s.url}`,
      ...(s.scope ? [`  scope: ${s.scope}`] : []),
      ...(s.scope_files && s.scope_files.length > 0
        ? [`  scope files: ${s.scope_files.join(", ")}`]
        : []),
      `  comments: ${s.comments.total} total — ${s.comments.draft} draft, ` +
        `${s.comments.submitted} submitted, ${s.comments.addressed} addressed, ` +
        `${s.comments.resolved} resolved, ${s.comments.orphaned} orphaned`,
    ].join("\n"),
  );
  return 0;
}

function formatComment(c: ReviewComment): string {
  const range = c.line === c.end_line ? `${c.line}` : `${c.line}-${c.end_line}`;
  const tag = c.tag ? ` (${c.tag})` : "";
  const location =
    c.kind === "review"
      ? "(review-level)"
      : c.kind === "file-note"
        ? `${c.file} (file note)`
        : `${c.file}:${range} (${c.side})`;
  const lines = [`[${c.state}]${tag} ${c.id} ${location}`, `  ${c.text}`];
  for (const r of c.replies) lines.push(`  ↳ (${r.from}) ${r.text}`);
  return lines.join("\n");
}

async function cmdComments(args: ParsedArgs): Promise<number> {
  const json = args.flags.has("json");
  const lock = await requireDaemon(await requireRepoRoot());
  // Drafts are the reviewer's private workspace — always excluded here.
  const params = new URLSearchParams({ exclude_drafts: "1" });
  if (args.flags.has("unresolved")) params.set("unresolved", "1");
  const stateFlag = args.flags.get("state");
  if (typeof stateFlag === "string") {
    if (!COMMENT_STATES.has(stateFlag)) {
      throw new CliError(
        `invalid --state: ${stateFlag} (submitted | addressed | resolved | orphaned)`,
      );
    }
    params.set("state", stateFlag);
  } else if (stateFlag === true) {
    throw new CliError("--state requires a value");
  }
  const { comments } = await api<{ comments: ReviewComment[] }>(
    lock,
    `/api/comments?${params.toString()}`,
  );
  out(json, { comments }, () =>
    comments.length === 0 ? "no comments" : comments.map(formatComment).join("\n"),
  );
  return 0;
}

async function cmdWait(args: ParsedArgs): Promise<number> {
  const json = args.flags.has("json");
  const timeoutFlag = args.flags.get("timeout");
  const timeoutS = typeof timeoutFlag === "string" ? Number(timeoutFlag) : 60;
  if (!Number.isFinite(timeoutS) || timeoutS < 0) throw new CliError("invalid --timeout");
  const lock = await requireDaemon(await requireRepoRoot());
  const result = await api<WaitResult>(lock, `/api/wait?timeout=${timeoutS}`, {
    timeoutMs: (timeoutS + 30) * 1_000,
  });
  out(json, result, (r: WaitResult) => {
    switch (r.reason) {
      case "ready":
        return "review marked ready — session complete";
      case "feedback":
        return `feedback received:\n${r.comments.map(formatComment).join("\n")}`;
      case "timeout":
        return "timeout (safe to call wait again)";
    }
  });
  // Distinct exit codes: ready=0, feedback=2, timeout=3.
  return result.reason === "ready" ? 0 : result.reason === "feedback" ? 2 : 3;
}

async function cmdResolve(args: ParsedArgs): Promise<number> {
  const json = args.flags.has("json");
  const id = args.positional[0];
  if (!id) throw new CliError("usage: prediff resolve <comment-id> [--reply <text>]");
  const lock = await requireDaemon(await requireRepoRoot());
  const reply = args.flags.get("reply");
  const comment = await api<ReviewComment>(lock, `/api/comments/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    body: JSON.stringify(typeof reply === "string" ? { reply } : {}),
  });
  out(json, comment, formatComment);
  return 0;
}

async function cmdRefresh(args: ParsedArgs): Promise<number> {
  const json = args.flags.has("json");
  const lock = await requireDaemon(await requireRepoRoot());
  const result = await api<{
    changed: boolean;
    revision: number;
    files: number;
    additions: number;
    deletions: number;
  }>(lock, "/api/refresh", { method: "POST", timeoutMs: 60_000 });
  out(json, result, (r: typeof result) =>
    `revision ${r.revision}${r.changed ? " (diff changed)" : " (no change)"}: ` +
    `${r.files} file(s), +${r.additions} -${r.deletions}`,
  );
  return 0;
}

async function cmdStop(args: ParsedArgs): Promise<number> {
  const json = args.flags.has("json");
  const root = await requireRepoRoot();
  const lock = await findDaemon(root);
  if (!lock) {
    out(json, { stopped: false, reason: "not running" }, () => "no daemon running");
    return 0;
  }
  try {
    await api(lock, "/api/shutdown", { method: "POST" });
  } catch {
    // Daemon may be wedged; fall back to SIGTERM.
    if (pidAlive(lock.pid)) process.kill(lock.pid, "SIGTERM");
  }
  // Wait briefly for the process to exit.
  for (let i = 0; i < 50 && pidAlive(lock.pid); i++) await Bun.sleep(20);
  out(json, { stopped: true, pid: lock.pid }, () => `stopped daemon (pid ${lock.pid})`);
  return 0;
}

function cmdHelp(): number {
  console.log(
    [
      "usage: prediff <command> [args] [--json]",
      "",
      "commands:",
      "  open [range]              start/reuse daemon, open a review session",
      "                            range: working (default) | staged | HEAD | A..B | <commit-ish>",
      "                            flags: --json --ttl <s> --scope <task> --no-browser",
      "                                   --scope-files <globs>  (comma-separated, e.g.",
      "                                   \"src/lib/**,src/routes/users.ts\" — files matching",
      "                                   no pattern are flagged out-of-scope in the UI)",
      "  status                    session snapshot: state, revision, comment counts",
      "  comments [--state <s>]    list comments (drafts always excluded)",
      "           [--unresolved]   s: submitted | addressed | resolved | orphaned",
      "  wait --timeout <s>        long-poll; exits 0=ready 2=feedback 3=timeout",
      "  resolve <id> [--reply t]  mark a comment resolved (with an optional reply)",
      "  refresh                   recompute the diff (bumps the revision)",
      "  stop                      stop the daemon for this repo",
    ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help")) return cmdHelp();
  switch (args.command) {
    case "open":
      return cmdOpen(args);
    case "status":
      return cmdStatus(args);
    case "comments":
      return cmdComments(args);
    case "wait":
      return cmdWait(args);
    case "resolve":
      return cmdResolve(args);
    case "refresh":
      return cmdRefresh(args);
    case "stop":
      return cmdStop(args);
    case "help":
    default:
      return cmdHelp();
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const isCli = err instanceof CliError;
      const message = err instanceof Error ? err.message : String(err);
      if (process.argv.includes("--json")) {
        console.error(JSON.stringify({ error: message }));
      } else {
        console.error(`prediff: ${message}`);
      }
      process.exit(isCli ? (err as CliError).exitCode : 1);
    });
}
