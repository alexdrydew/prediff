/**
 * Daemon entry point. Spawned detached by `prediff open`:
 *   bun src/server/daemon.ts --repo <root> --range <spec> [--ttl <seconds>] [--port <n>]
 */

import { stateDir } from "../store/paths";
import { Daemon } from "./server";

export const DEFAULT_TTL_S = 4 * 60 * 60; // 4 hours

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repoRoot = argValue(argv, "--repo");
  if (!repoRoot) {
    console.error("usage: daemon.ts --repo <root> [--range <spec>] [--ttl <s>] [--port <n>]");
    process.exit(1);
  }
  const range = argValue(argv, "--range") ?? "working";
  const ttlS = Number(argValue(argv, "--ttl") ?? DEFAULT_TTL_S);
  const portArg = argValue(argv, "--port");

  const daemon = new Daemon({
    repoRoot,
    stateDir: await stateDir(repoRoot),
    range,
    ttlMs: ttlS * 1_000,
    ...(portArg !== undefined ? { port: Number(portArg) } : {}),
  });
  await daemon.start();
  console.log(`[prediff] daemon listening at ${daemon.url} (repo: ${repoRoot})`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[prediff] daemon failed to start:", err);
    process.exit(1);
  });
}
