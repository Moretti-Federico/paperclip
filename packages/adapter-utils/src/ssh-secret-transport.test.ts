import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every `ssh` invocation runs its remote script through a local `sh` instead,
// with $HOME pointed at a throwaway directory, and every argv is recorded so
// the tests can prove that no injected value ever reaches a command line.
const recordedArgv: string[][] = [];
let failProvisioning = false;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const remoteScript = (args: string[]) => {
    const script = args.at(-1)!;
    // Simulate a transport failure of the provisioning connection only.
    if (failProvisioning && script.includes("cat >")) return "cat >/dev/null; exit 255";
    return script;
  };
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      recordedArgv.push([file, ...args]);
      return actual.execFile("sh", ["-c", remoteScript(args)], options, callback);
    }),
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      recordedArgv.push([file, ...args]);
      return actual.spawn("sh", ["-c", remoteScript(args)], options);
    }),
  };
});

import {
  buildRemoteEnvFileContent,
  buildSshSpawnTarget,
  createSshCommandManagedRuntimeRunner,
  remoteEnvFilePathExpr,
  runSshCommand,
} from "./ssh.js";

const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");

// Synthetic values only. The tricky one exercises quoting, command
// substitution, newlines (including a trailing one), and non-ASCII bytes.
const SENTINEL = "SYNTH-SECRET-6f1c2e9a";
const TRICKY = `${SENTINEL}-multi\nline 'single' "double" $(echo injected) \`echo injected\` \\ ünïcode ~ * ; |\n`;

const spec = {
  host: "fixture.invalid",
  port: 22,
  username: "fixture",
  remoteCwd: "/",
  remoteWorkspacePath: "/",
  privateKey: "SYNTH-PRIVATE-KEY-not-a-real-key",
  knownHosts: null,
  strictHostKeyChecking: false,
};

let fakeHome = "";
let previousHome: string | undefined;
const envDir = () => path.join(fakeHome, ".paperclip-run-env");

function argvLeaks(value: string): string[][] {
  return recordedArgv.filter((argv) => argv.some((arg) => arg.includes(value)));
}

async function envFiles(): Promise<string[]> {
  try {
    return (await readdir(envDir())).filter((name) => name.endsWith(".env"));
  } catch {
    return [];
  }
}

function runTarget(target: { args: string[] }, stdin: string | null): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = actualChildProcess.spawn("sh", ["-c", target.args.at(-1)!], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not reached");
}

beforeEach(async () => {
  recordedArgv.length = 0;
  failProvisioning = false;
  fakeHome = await mkdtemp(path.join(os.tmpdir(), "ssh-secret-transport-home-"));
  previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(fakeHome, { recursive: true, force: true });
});

describe("SSH secret transport", () => {
  it("builds an env file that deletes itself first and quotes every value", () => {
    const pathExpr = remoteEnvFilePathExpr("00000000-0000-4000-8000-000000000000");
    expect(pathExpr).toBe('"$HOME/.paperclip-run-env/00000000-0000-4000-8000-000000000000.env"');
    const content = buildRemoteEnvFileContent([["A_TOKEN", "x'y"]], pathExpr);
    expect(content.split("\n")[0]).toBe(`rm -f -- ${pathExpr}`);
    expect(content).toContain(`export A_TOKEN='x'"'"'y'`);
    expect(() => remoteEnvFilePathExpr("../../etc/passwd")).toThrow("UUID");
    expect(() => buildRemoteEnvFileContent([["-u", "PATH"]], pathExpr)).toThrow("Invalid SSH environment variable key");
  });

  it("keeps spawn-target values out of every argv while preserving env, stdin, and quoting", async () => {
    const target = await buildSshSpawnTarget({
      spec,
      command: "sh",
      args: ["-c", 'printf "%s|" "$1"; printf "%s" "$SYNTH_API_KEY" > "$2"; cat', "probe", "it's two words", path.join(fakeHome, "value.out")],
      env: { SYNTH_API_KEY: TRICKY, SYNTH_PLAIN: "plain" },
    });

    expect(target.command).toBe("ssh");
    expect(argvLeaks(SENTINEL)).toEqual([]);
    expect(target.args.some((arg) => arg.includes(SENTINEL))).toBe(false);
    expect(target.args.at(-1)).not.toContain("exec env");
    expect(target.args.at(-1)).toContain(".paperclip-run-env/");
    // The SSH private key travels as a 0600 temp file path, never as content.
    expect(argvLeaks("SYNTH-PRIVATE-KEY")).toEqual([]);

    // Before launch, the staged file is private.
    const [staged] = await envFiles();
    expect(staged).toMatch(/^[0-9a-f-]{36}\.env$/);
    expect((await stat(envDir())).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(envDir(), staged!))).mode & 0o777).toBe(0o600);

    const result = await runTarget(target, "streamed stdin\nsecond line\n");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("it's two words|streamed stdin\nsecond line\n");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(fakeHome, "value.out"), "utf8")).toBe(TRICKY);
    // Sourcing consumed the file before the command even started.
    expect(await envFiles()).toEqual([]);
    await target.cleanup();
  });

  it("consumes the env file even when the remote cwd is missing", async () => {
    const target = await buildSshSpawnTarget({
      spec: { ...spec, remoteCwd: path.join(fakeHome, "missing-dir") },
      command: "true",
      args: [],
      env: { SYNTH_API_KEY: SENTINEL },
    });
    const result = await runTarget(target, null);
    expect(result.code).not.toBe(0);
    expect(await envFiles()).toEqual([]);
    await target.cleanup();
  });

  it("removes a staged env file when the launch never happens", async () => {
    const target = await buildSshSpawnTarget({ spec, command: "true", args: [], env: { SYNTH_API_KEY: SENTINEL } });
    expect(await envFiles()).toHaveLength(1);
    await target.cleanup();
    await waitFor(async () => (await envFiles()).length === 0);
    expect(argvLeaks(SENTINEL)).toEqual([]);
  });

  it("opens a single connection and stages nothing without env", async () => {
    const target = await buildSshSpawnTarget({ spec, command: "true", args: [], env: {} });
    expect(recordedArgv).toEqual([]);
    expect(target.args.at(-1)).not.toContain(".paperclip-run-env");
    await target.cleanup();
  });

  it("runs commands with env values only through the private file", async () => {
    const result = await runSshCommand(spec, 'printf "%s" "$SYNTH_API_KEY"', {
      env: { SYNTH_API_KEY: TRICKY },
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe(TRICKY);
    expect(argvLeaks(SENTINEL)).toEqual([]);
    expect(await envFiles()).toEqual([]);
    // Provisioning + command: no extra cleanup round-trip on success.
    expect(recordedArgv).toHaveLength(2);
  });

  it("keeps values out of failure messages and removes the file on failure", async () => {
    const error = await runSshCommand(spec, 'printf "%s" "$SYNTH_API_KEY" >/dev/null; echo failing >&2; exit 3', {
      env: { SYNTH_API_KEY: SENTINEL },
      timeoutMs: 10_000,
    }).then(
      () => null,
      (caught: unknown) => caught as Error & { code?: unknown; stderr?: string },
    );
    if (!error) throw new Error("expected the remote command to fail");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(3);
    // Node's execFile error message embeds the full ssh command line.
    expect(error.message).not.toContain(SENTINEL);
    expect(error.stderr).toContain("failing");
    expect(argvLeaks(SENTINEL)).toEqual([]);
    expect(await envFiles()).toEqual([]);
  });

  it("cleans up and reports a provisioning failure", async () => {
    failProvisioning = true;
    await expect(runSshCommand(spec, "true", { env: { SYNTH_API_KEY: SENTINEL }, timeoutMs: 10_000 })).rejects.toThrow();
    await expect(buildSshSpawnTarget({ spec, command: "true", args: [], env: { SYNTH_API_KEY: SENTINEL } })).rejects.toThrow();
    expect(argvLeaks(SENTINEL)).toEqual([]);
    expect(await envFiles()).toEqual([]);
    // The cleanup connection was attempted after each failure.
    expect(recordedArgv.filter((argv) => !argv.at(-1)!.includes("cat >") && argv.at(-1)!.includes("rm -f --"))).toHaveLength(2);
  });

  it("purges orphaned env files older than the retention window", async () => {
    await mkdir(envDir(), { recursive: true, mode: 0o700 });
    const orphan = path.join(envDir(), "11111111-1111-4111-8111-111111111111.env");
    const recent = path.join(envDir(), "22222222-2222-4222-8222-222222222222.env");
    await writeFile(orphan, "export X=1\n", { mode: 0o600 });
    await writeFile(recent, "export X=1\n", { mode: 0o600 });
    const old = new Date(Date.now() - 20 * 60_000);
    await utimes(orphan, old, old);

    await runSshCommand(spec, "true", { env: { SYNTH_API_KEY: SENTINEL }, timeoutMs: 10_000 });
    expect((await envFiles()).sort()).toEqual([path.basename(recent)]);
  });

  it("keeps managed-runtime command env out of argv", async () => {
    const runner = createSshCommandManagedRuntimeRunner({ spec: { ...spec, remoteCwd: fakeHome } });
    const result = await runner.execute({
      command: "sh",
      args: ["-c", 'printf "%s" "$SYNTH_API_KEY"'],
      env: { SYNTH_API_KEY: TRICKY },
      stdin: "",
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(TRICKY);
    expect(argvLeaks(SENTINEL)).toEqual([]);
    expect(await envFiles()).toEqual([]);
  });

  it("lets caller env override values a login profile exports", async () => {
    await writeFile(path.join(fakeHome, ".profile"), "export SYNTH_OVERRIDE=from-profile\n");
    const result = await runSshCommand(spec, 'printf "%s" "$SYNTH_OVERRIDE"', {
      env: { SYNTH_OVERRIDE: "from-caller" },
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe("from-caller");
  });
});
