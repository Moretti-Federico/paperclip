// Runs the REAL production runtime chunk (or its patched copy) against a local
// sshd fixture with synthetic credentials, and reports how many processes
// expose a synthetic value in their argv during each SSH path.
// usage: tsx verify-runtime-chunk.mts <dist-runtime dir> <worktree>
// Prints only counts and lengths, never values.
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeDir, worktree] = process.argv.slice(2);
const ssh = await import(pathToFileURL(path.join(worktree, "packages/adapter-utils/src/ssh.ts")).href);
const chunk = await import(pathToFileURL(path.join(runtimeDir, "chunk-3ZK6CBQV.mjs")).href);

async function argvHits(needle: string): Promise<number> {
  let hits = 0;
  for (const entry of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`).catch(() => null);
    if (cmdline?.includes(needle)) hits += 1;
  }
  return hits;
}

async function whileRunning<T>(needle: string, run: () => Promise<T>): Promise<{ result: T; maxHits: number }> {
  let active = true;
  let maxHits = 0;
  const scanner = (async () => {
    while (active) {
      maxHits = Math.max(maxHits, await argvHits(needle));
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  try {
    return { result: await run(), maxHits };
  } finally {
    active = false;
    await scanner;
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "pc-runtime-verify-"));
const state = await ssh.startSshEnvLabFixture({ statePath: path.join(root, "state.json") });
const report: Record<string, unknown> = {};
let failed = false;
try {
  const config = await ssh.buildSshEnvLabFixtureConfig(state);
  const spec = { ...config, remoteCwd: state.workspaceDir };
  const sentinel = `SYNTH-RUNTIME-${process.pid}-${Date.now()}`;
  const value = `${sentinel} 'q' "d" $(echo x)\nline2\n`;

  // 1. Agent CLI launch path (claude/codex/opencode): runChildProcess -> buildSshSpawnTarget.
  let out = "";
  const agent = await whileRunning(sentinel, () => chunk.runChildProcess("synthetic-run", "sh", [
    "-c", 'IFS= read -r p; printf "p=%s len=%s\\n" "$p" "$(printf "%s" "$SYNTH_API_KEY" | wc -c)"; sleep 1',
  ], {
    cwd: process.cwd(), env: { SYNTH_API_KEY: value }, stdin: "prompt 'x'\n",
    timeoutSec: 30, graceSec: 5, remoteExecution: spec,
    onLog: async (_s: string, c: string) => { out += c; },
  }));
  report.agentLaunch = {
    exitCode: agent.result.exitCode, maxArgvHits: agent.maxHits,
    outputOk: out === `p=prompt 'x' len=${Buffer.byteLength(value)}\n`,
  };

  // 2. runSshCommand with env (shell commands: Claude config, OpenCode skills).
  const direct = await whileRunning(sentinel, () =>
    chunk.runSshCommand(config, 'sleep 1; printf "%s" "$SYNTH_API_KEY"', { env: { SYNTH_API_KEY: value }, timeoutMs: 20_000 }));
  report.runSshCommand = { maxArgvHits: direct.maxHits, valueRoundTrip: direct.result.stdout === value };

  // 3. Managed-runtime runner (native runtime / command probes).
  const runner = chunk.createSshCommandManagedRuntimeRunner({ spec });
  const managed = await whileRunning(sentinel, () => runner.execute({
    command: "sh", args: ["-c", 'sleep 1; printf "%s" "$SYNTH_API_KEY"'], env: { SYNTH_API_KEY: value }, timeoutMs: 20_000,
  }));
  report.managedRunner = { maxArgvHits: managed.maxHits, valueRoundTrip: managed.result.stdout === value };

  const envDir = path.join(os.homedir(), ".paperclip-run-env");
  let leftovers = 0;
  for (const name of await readdir(envDir).catch(() => [] as string[])) {
    if ((await readFile(path.join(envDir, name), "utf8").catch(() => "")).includes(sentinel)) leftovers += 1;
  }
  report.remoteEnvFilesLeft = leftovers;
  failed = agent.maxHits + direct.maxHits + managed.maxHits + leftovers > 0
    || !(report.agentLaunch as { outputOk: boolean }).outputOk
    || !(report.runSshCommand as { valueRoundTrip: boolean }).valueRoundTrip
    || !(report.managedRunner as { valueRoundTrip: boolean }).valueRoundTrip;
} finally {
  await ssh.stopSshEnvLabFixture(state).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
console.log(failed ? "VERDICT=LEAK_OR_FAILURE" : "VERDICT=NO_ARGV_EXPOSURE");
process.exit(failed ? 1 : 0);
