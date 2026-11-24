import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  type AdapterSshExecutionTarget,
} from "./execution-target.js";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "./ssh.js";

// End-to-end through the shared entry points that claude_local, codex_local and
// opencode_local call for an SSH execution target, against a real sshd. The
// fixture runs on this host, so scanning /proc covers both the local ssh client
// and every remote-side process. Synthetic values only.
const TIMEOUT_MS = 60_000;
const roots: string[] = [];
const fixtures: SshEnvLabFixtureState[] = [];

afterAll(async () => {
  for (const state of fixtures.splice(0)) await stopSshEnvLabFixture(state).catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function argvHits(needle: string): Promise<number> {
  let hits = 0;
  for (const entry of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`).catch(() => null);
    if (cmdline?.includes(needle)) hits += 1;
  }
  return hits;
}

async function startTarget(): Promise<AdapterSshExecutionTarget | null> {
  const support = await getSshEnvLabSupport();
  if (!support.supported || process.platform !== "linux") {
    console.warn(`Skipping SSH secret transport fixture test: ${support.reason ?? "not Linux"}`);
    return null;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-secret-"));
  roots.push(root);
  const state = await startSshEnvLabFixture({ statePath: path.join(root, "state.json") });
  fixtures.push(state);
  const config = await buildSshEnvLabFixtureConfig(state);
  return {
    kind: "remote",
    transport: "ssh",
    remoteCwd: state.workspaceDir,
    spec: { ...config, remoteCwd: state.workspaceDir },
  };
}

describe("SSH secret transport through adapter execution targets", () => {
  it("never exposes injected values in any argv while the agent process runs", async () => {
    const target = await startTarget();
    if (!target) return;
    const sentinel = `SYNTH-ADAPTER-SECRET-${process.pid}-${Date.now()}`;
    const env = {
      PAPERCLIP_API_KEY: `${sentinel}-api`,
      GH_TOKEN: `${sentinel}-gh`,
      PAPERCLIP_AGENT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${sentinel}-pem\n-----END PRIVATE KEY-----\n`,
      PAPERCLIP_RUN_ID: "run-plain",
    };

    let spawnedPid: number | null = null;
    let midRunHits = -1;
    const logs: string[] = [];
    // Like the CLI adapters: prompt on stdin, streamed stdout, env-dependent
    // behaviour. The command waits for stdin so the scan happens mid-run.
    const result = await runAdapterExecutionTargetProcess("synthetic-run", target, "sh", [
      "-c",
      'IFS= read -r prompt; midrun=$(printf "%s" "$PAPERCLIP_API_KEY" | wc -c); printf "prompt=%s key_len=%s pem_lines=%s run=%s\\n" "$prompt" "$midrun" "$(printf "%s" "$PAPERCLIP_AGENT_PRIVATE_KEY" | wc -l)" "$PAPERCLIP_RUN_ID"; sleep 1',
    ], {
      cwd: process.cwd(),
      env,
      stdin: "synthetic prompt with 'quotes'\n",
      timeoutSec: 30,
      graceSec: 5,
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
        if (chunk.includes("prompt=") && midRunHits < 0) midRunHits = await argvHits(sentinel);
      },
      onSpawn: async ({ pid }) => { spawnedPid = pid; },
    });

    expect(result.exitCode).toBe(0);
    expect(spawnedPid).not.toBeNull();
    expect(midRunHits).toBe(0);
    expect(logs.join("")).toBe(`prompt=synthetic prompt with 'quotes' key_len=${env.PAPERCLIP_API_KEY.length} pem_lines=3 run=run-plain\n`);
    expect(logs.join("")).not.toContain(sentinel);
    expect(await argvHits(sentinel)).toBe(0);
  }, TIMEOUT_MS);

  it("keeps shell-command env (Claude config / OpenCode skills setup) out of argv", async () => {
    const target = await startTarget();
    if (!target) return;
    const sentinel = `SYNTH-SHELL-SECRET-${process.pid}-${Date.now()}`;
    // Scan concurrently while the short-lived ssh command is alive.
    let scanning = true;
    let maxHits = 0;
    const scanner = (async () => {
      while (scanning) {
        maxHits = Math.max(maxHits, await argvHits(sentinel));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const result = await runAdapterExecutionTargetShellCommand("synthetic-run", target,
      'test "$ZHIPU_API_KEY" = "$EXPECTED" && sleep 1 && echo matched', {
        cwd: process.cwd(),
        env: { ZHIPU_API_KEY: sentinel, EXPECTED: sentinel },
        timeoutSec: 30,
      });
    scanning = false;
    await scanner;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("matched");
    expect(maxHits).toBe(0);
    expect(await argvHits(sentinel)).toBe(0);
  }, TIMEOUT_MS);
});
