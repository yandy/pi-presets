import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  expandPresetArgs,
  listPresets,
  PresetUsageError,
} from '../src/presets.ts';

const root = mkdtempSync(join(tmpdir(), 'pi-presets-core-'));
for (const name of ['office', 'coding']) {
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, 'package.json'), JSON.stringify({ name }));
}
mkdirSync(join(root, 'not-a-package'));
after(() => rmSync(root, { recursive: true, force: true }));

test('expands -ps in place and preserves the remaining arguments', () => {
  assert.deepEqual(
    expandPresetArgs(['-ps', 'coding', '-p', 'hello'], root),
    ['-e', join(root, 'coding'), '-p', 'hello'],
  );
});

test('expands comma-separated and repeated long options in order', () => {
  assert.deepEqual(
    expandPresetArgs(
      ['--preset', 'coding, office', '--preset=office', '--', '-ps', 'coding'],
      root,
    ),
    [
      '-e', join(root, 'coding'),
      '-e', join(root, 'office'),
      '-e', join(root, 'office'),
      '--', '-ps', 'coding',
    ],
  );
});

test('does not interpret preset-like arguments after --', () => {
  const args = ['--model', 'sonnet', '--', '--preset', 'missing'];
  assert.deepEqual(expandPresetArgs(args, root), args);
});

test('passes arguments through unchanged when no preset option is present', () => {
  const args = ['-ps=coding', '-p', 'hello'];
  assert.deepEqual(expandPresetArgs(args, root), args);
});

test('rejects missing preset option values', () => {
  for (const args of [['-ps'], ['--preset']]) {
    assert.throws(() => expandPresetArgs(args, root), PresetUsageError);
  }
});

test('rejects empty, traversing, and path-like preset names', () => {
  const values = [
    '', 'coding,,office', 'coding, ,office', '.', '..',
    '../coding', 'coding/office', 'coding\\office',
  ];
  for (const value of values) {
    assert.throws(
      () => expandPresetArgs(['--preset', value], root),
      PresetUsageError,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test('rejects unknown presets and reports sorted available names', () => {
  assert.deepEqual(listPresets(root), ['coding', 'office']);

  for (const name of ['missing', 'not-a-package']) {
    assert.throws(
      () => expandPresetArgs(['-ps', name], root),
      (error: unknown) => {
        assert.ok(error instanceof PresetUsageError);
        assert.match(error.message, /coding/);
        assert.match(error.message, /office/);
        return true;
      },
    );
  }
});
