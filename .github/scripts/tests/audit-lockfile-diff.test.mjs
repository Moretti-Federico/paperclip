import assert from 'node:assert/strict';
import test from 'node:test';
import { compareAudits, findings } from '../audit-lockfile-diff.mjs';

function report(rows = []) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }, advisories = {};
  for (const [id, name, version, severity] of rows) {
    counts[severity]++;
    advisories[id] ??= { id, module_name: name, severity, findings: [] };
    advisories[id].findings.push({ version, paths: [] });
  }
  return { advisories, muted: [], metadata: { vulnerabilities: counts } };
}

test('distinguishes inherited, removed and newly affected versions at every severity', () => {
  const base = report([[1, 'inherited', '1.0.0', 'critical'], [2, 'removed', '1.0.0', 'low'], [3, 'changed', '1.0.0', 'high']]);
  const head = report([[1, 'inherited', '1.0.0', 'critical'], [3, 'changed', '1.1.0', 'high'], [4, 'new-dev', '1.0.0', 'low']]);
  const delta = compareAudits(base, head);
  assert.equal(delta.inherited, 1);
  assert.equal(delta.resolved, 2);
  assert.deepEqual(delta.introduced.map(row => row.package), ['changed', 'new-dev']);
  assert.equal(compareAudits(base, base).introduced.length, 0);
  assert.equal(findings(report()).size, 0);
});

test('registry errors, ignored findings and incomplete totals cannot produce a clean result', () => {
  const valid = report([[1, 'test', '1.0.0', 'high']]);
  for (const invalid of [null, {}, { ...valid, error: 'registry unavailable' }, { ...valid, muted: [1] },
    { ...valid, advisories: {} }, { ...valid, metadata: { vulnerabilities: {} } },
    { ...valid, advisories: { 1: { id: 1, module_name: 'test', severity: 'unknown', findings: [{ version: '1' }] } } }]) {
    assert.throws(() => compareAudits(valid, invalid));
    assert.throws(() => compareAudits(invalid, valid));
  }
});
