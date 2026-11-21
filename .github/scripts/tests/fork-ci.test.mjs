import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../../workflows/ci-routing.yml', import.meta.url), 'utf8');
for (const [step, env, expected] of [
  ['Validate PR identity and select runner', { AWS_CI_ENABLED: 'true', EVENT_NAME: 'pull_request' }, 'runner=ubuntu-latest'],
  ['Authorize CODEOWNERS CI profiling', { PROFILE_REQUESTED: 'true' }, 'profile_ci=false'],
  ['Plan affected CI tasks from trusted definitions', {}, 'plan='],
]) {
  test(`fork ${step} never downloads or executes upstream code`, () => {
    const body = workflow.split(`      - name: ${step}\n`)[1]?.split(/\n      - name:/)[0];
    assert.ok(body, `Missing step: ${step}`);
    const script = body.split('        run: |\n')[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
    const root = mkdtempSync(join(tmpdir(), 'fork-ci-'));
    try {
      const bin = join(root, 'bin'), output = join(root, 'output'), marker = join(root, 'api-called');
      mkdirSync(bin);
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf called > "$API_MARKER"\nexit 97\n', { mode: 0o755 });
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
        PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: output, API_MARKER: marker,
        EVENT_REPOSITORY: 'Moretti-Federico/paperclip', ...env,
      } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, 'utf8').trim(), expected);
      assert.equal(existsSync(marker), false, 'Fork routing must not call the upstream API');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
