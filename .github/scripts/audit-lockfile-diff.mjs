import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// pnpm 9's audit response. Reject incomplete/error/muted reports rather than
// turning a registry problem or a configured ignore into a clean delta.
export function findings(report) {
  assert.ok(report && !report.error && report.advisories && report.metadata?.vulnerabilities, 'Incomplete audit response');
  assert.deepEqual(report.muted, [], 'Audit findings must not be muted');
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const result = new Map();
  for (const advisory of Object.values(report.advisories)) {
    assert.ok(advisory && advisory.id && typeof advisory.module_name === 'string' && advisory.module_name.length);
    assert.ok(Object.hasOwn(counts, advisory.severity), 'Unknown severity');
    assert.ok(Array.isArray(advisory.findings) && advisory.findings.length, 'Missing affected versions');
    for (const finding of advisory.findings) {
      assert.ok(typeof finding.version === 'string' && finding.version.length, 'Missing affected version');
      counts[advisory.severity]++;
      const key = JSON.stringify([advisory.id, advisory.module_name, finding.version, advisory.severity]);
      result.set(key, { advisory: advisory.id, package: advisory.module_name, version: finding.version, severity: advisory.severity });
    }
  }
  assert.deepEqual(counts, report.metadata.vulnerabilities, 'Audit totals do not match findings');
  return result;
}

export function compareAudits(base, head) {
  const previous = findings(base), current = findings(head);
  return {
    introduced: [...current].filter(([key]) => !previous.has(key)).map(([, value]) => value),
    inherited: [...current.keys()].filter(key => previous.has(key)).length,
    resolved: [...previous.keys()].filter(key => !current.has(key)).length,
    baseTotals: base.metadata.vulnerabilities,
    headTotals: head.metadata.vulnerabilities,
  };
}

function audit(lockfile, directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'package.json'), '{"private":true}\n');
  writeFileSync(resolve(directory, 'pnpm-lock.yaml'), lockfile);
  // These retained reports live below the checkout. Do not let pnpm discover
  // the ancestor workspace and audit its resolved lockfile instead of this
  // immutable base/head copy.
  const run = spawnSync('pnpm', ['--ignore-workspace', 'audit', '--json'], { cwd: directory, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(resolve(directory, 'audit.json'), run.stdout ?? '');
  writeFileSync(resolve(directory, 'audit.stderr'), run.stderr ?? '');
  assert.ok(!run.error && !run.signal && [0, 1].includes(run.status), `Audit execution failed: ${run.error?.message ?? run.status}`);
  const report = JSON.parse(run.stdout);
  findings(report);
  return report;
}

function main() {
  const base = process.env.BASE_SHA;
  assert.match(base ?? '', /^[0-9a-f]{40}$/, 'BASE_SHA must be an immutable commit');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const lock = sha => execFileSync('git', ['show', `${sha}:pnpm-lock.yaml`], { maxBuffer: 16 * 1024 * 1024 });
  const before = lock(base), after = lock(head), directory = resolve('.dependency-audit');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'inputs.json'), JSON.stringify({ base, head, identicalLockfile: before.equals(after) }, null, 2));
  const baseline = audit(before, resolve(directory, 'base'));
  // Identical graph: use one registry snapshot, avoiding contradictory answers
  // when advisory data changes between two requests for the same dependencies.
  const proposed = before.equals(after) ? baseline : audit(after, resolve(directory, 'head'));
  writeFileSync(resolve(directory, 'head-audit.json'), JSON.stringify(proposed));
  const comparison = compareAudits(baseline, proposed);
  writeFileSync(resolve(directory, 'comparison.json'), JSON.stringify(comparison, null, 2));
  console.log(JSON.stringify(comparison, null, 2));
  if (comparison.introduced.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
