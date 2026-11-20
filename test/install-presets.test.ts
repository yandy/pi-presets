import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installPresetDependencies,
  type ProcessRunner,
} from '../src/install-presets.ts';
import { listPresets } from '../src/presets.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function makeTree(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-presets-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function addPreset(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  { lock = false }: { lock?: boolean } = {},
): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  if (lock) writeFileSync(join(directory, 'package-lock.json'), '{}');
  return directory;
}

test('installs each dependency group locally with the lockfile-aware npm command', async (t) => {
  const root = makeTree(t);
  const alpha = addPreset(root, 'alpha', { dependencies: { a: '1.0.0' } }, { lock: true });
  const beta = addPreset(root, 'beta', { devDependencies: { b: '1.0.0' } });
  const gamma = addPreset(root, 'gamma', { optionalDependencies: { c: '1.0.0' } }, { lock: true });
  addPreset(root, 'empty', { dependencies: {}, devDependencies: {} });
  addPreset(root, 'node_modules', { dependencies: { ignored: '1.0.0' } });
  mkdirSync(join(root, 'not-a-package'));
  const calls: Array<{
    command: string;
    args: string[];
    options: SpawnOptions;
  }> = [];
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, options });
  };

  const installed = await installPresetDependencies({ repoRoot: root, runner });

  assert.deepEqual(installed, ['alpha', 'beta', 'gamma']);
  assert.deepEqual(calls, [
    { command: 'npm', args: ['ci'], options: { cwd: alpha, stdio: 'inherit' } },
    { command: 'npm', args: ['install'], options: { cwd: beta, stdio: 'inherit' } },
    { command: 'npm', args: ['ci'], options: { cwd: gamma, stdio: 'inherit' } },
  ]);
});

test('reports the preset whose package manifest is invalid', async (t) => {
  const root = makeTree(t);
  const broken = join(root, 'broken');
  mkdirSync(broken);
  writeFileSync(join(broken, 'package.json'), '{not json');

  await assert.rejects(
    installPresetDependencies({ repoRoot: root, runner: async () => {} }),
    /broken.*package\.json/i,
  );
});

test('reports the preset whose dependency installation fails', async (t) => {
  const root = makeTree(t);
  addPreset(root, 'broken-install', { dependencies: { a: '1.0.0' } });

  await assert.rejects(
    installPresetDependencies({
      repoRoot: root,
      runner: async () => { throw new Error('npm exploded'); },
    }),
    /broken-install.*npm exploded/i,
  );
});

test('office is an empty private package and both documented presets exist', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'office', 'package.json'), 'utf8'));

  assert.equal(manifest.name, '@yandy/pi-preset-office');
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.pi, undefined);
  assert.deepEqual(listPresets(repoRoot), ['coding', 'office']);
});
