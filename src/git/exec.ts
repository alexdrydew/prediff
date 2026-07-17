/** Thin wrapper around shelling out to `git`. */

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** Common flags: never quote/escape non-ASCII paths, never colorize. */
const BASE_ARGS = ["-c", "core.quotepath=false"] as const;

export async function git(
  repo: string,
  args: string[],
  opts: { allowFail?: boolean } = {},
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...BASE_ARGS, ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !opts.allowFail) {
    throw new GitError(args, code, stderr);
  }
  return { stdout, stderr, code };
}

/** Resolve a revision to a full sha, or null if it doesn't resolve. */
export async function revParse(repo: string, rev: string): Promise<string | null> {
  const r = await git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
    allowFail: true,
  });
  if (r.code !== 0) return null;
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** Repo toplevel for a path inside it, or null if not a git repo. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}
