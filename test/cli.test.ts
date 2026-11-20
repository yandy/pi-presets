import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const recordingPi = String.raw`
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin: input,
  }));
  process.stdout.write('fake stdout\n');
  process.stderr.write('fake stderr\n');
  process.exit(Number(process.env.FAKE_PI_EXIT_CODE || 0));
});
`;

interface Harness {
  bin: string;
  capture: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
}

function makeHarness(t: TestContext, source: string = recordingPi): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'pi-presets-cli-'));
  const bin = join(directory, 'bin');
  const cwd = join(directory, 'work');
  const capture = join(directory, 'capture.json');
  mkdirSync(bin);
  mkdirSync(cwd);
  const executable = join(bin, 'pi');
  writeFileSync(executable, `#!${process.execPath}\n${source}`);
  chmodSync(executable, 0o755);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return {
    bin,
    capture,
    cwd,
    env: {
      ...process.env,
      PATH: bin,
      FAKE_PI_CAPTURE: capture,
    },
  };
}

function runCli(
  harness: Harness,
  args: readonly string[],
  options: RunOptions = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: harness.cwd,
    env: { ...harness.env, ...options.env },
    input: options.input ?? '',
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('expands a preset and preserves cwd, stdio, and remaining argv', (t) => {
  const harness = makeHarness(t);
  const result = runCli(harness, ['-ps', 'coding', '-p', 'hello'], {
    input: 'stdin payload\n',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'fake stdout\n');
  assert.equal(result.stderr, 'fake stderr\n');
  assert.deepEqual(JSON.parse(readFileSync(harness.capture, 'utf8')), {
    argv: ['-e', join(repoRoot, 'coding'), '-p', 'hello'],
    cwd: harness.cwd,
    stdin: 'stdin payload\n',
  });
});

test('passes arguments through unchanged without a preset option', (t) => {
  const harness = makeHarness(t);
  const args = ['--model', 'sonnet', '--', '-ps', 'not-loaded'];
  const result = runCli(harness, args);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(harness.capture, 'utf8')).argv, args);
});

test('returns the real Pi exit code', (t) => {
  const harness = makeHarness(t);
  const result = runCli(harness, ['--version'], {
    env: { FAKE_PI_EXIT_CODE: '23' },
  });

  assert.equal(result.status, 23);
});

test('forwards SIGTERM to the real Pi and returns its exit code', { timeout: 5000 }, async (t) => {
  const signalPi = String.raw`
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_PI_READY, 'ready');
process.on('SIGTERM', () => {
  fs.writeFileSync(process.env.FAKE_PI_CAPTURE, 'received SIGTERM');
  process.exit(42);
});
setInterval(() => {}, 1000);
`;
  const harness = makeHarness(t, signalPi);
  const ready = join(harness.cwd, 'ready');
  const child = spawn(process.execPath, [cliPath, '-ps', 'coding'], {
    cwd: harness.cwd,
    env: { ...harness.env, FAKE_PI_READY: ready },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let attempts = 0;
  while (!existsSync(ready) && attempts < 100) {
    await delay(20);
    attempts += 1;
  }
  assert.ok(existsSync(ready), 'fake Pi did not become ready');

  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 42);
  assert.equal(signal, null);
  assert.equal(readFileSync(harness.capture, 'utf8'), 'received SIGTERM');
});

test('does not forward a second SIGINT after foreground process-group delivery', { timeout: 5000 }, async (t) => {
  const interruptiblePi = String.raw`
const fs = require('node:fs');
let interrupts = 0;
fs.writeFileSync(process.env.FAKE_PI_READY, 'ready');
process.on('SIGINT', () => {
  interrupts += 1;
  fs.writeFileSync(process.env.FAKE_PI_CAPTURE, String(interrupts));
  setTimeout(() => process.exit(interrupts === 1 ? 42 : 43), 100);
});
setInterval(() => {}, 1000);
`;
  const harness = makeHarness(t, interruptiblePi);
  const ready = join(harness.cwd, 'ready');
  const child = spawn(process.execPath, [cliPath, '-ps', 'coding'], {
    cwd: harness.cwd,
    detached: true,
    env: { ...harness.env, FAKE_PI_READY: ready },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const childPid = child.pid;
  assert.ok(childPid !== undefined);
  t.after(() => {
    try { process.kill(-childPid, 'SIGKILL'); } catch { /* already exited */ }
  });

  let attempts = 0;
  while (!existsSync(ready) && attempts < 100) {
    await delay(20);
    attempts += 1;
  }
  assert.ok(existsSync(ready), 'fake Pi did not become ready');

  const exited = once(child, 'exit');
  process.kill(-childPid, 'SIGINT');
  const [code, signal] = await exited;
  assert.equal(code, 42);
  assert.equal(signal, null);
  assert.equal(readFileSync(harness.capture, 'utf8'), '1');
});

test('fails clearly when PATH has no executable Pi', (t) => {
  const harness = makeHarness(t);
  rmSync(join(harness.bin, 'pi'));
  mkdirSync(join(harness.bin, 'pi'));
  const nonExecutableBin = join(harness.cwd, 'non-executable-bin');
  mkdirSync(nonExecutableBin);
  writeFileSync(join(nonExecutableBin, 'pi'), 'not executable');
  const result = runCli(harness, ['--version'], {
    env: { PATH: `${harness.bin}${delimiter}${nonExecutableBin}` },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not find.*pi/i);
  assert.equal(existsSync(harness.capture), false);
});

test('returns 2 for preset usage errors without starting Pi', (t) => {
  const harness = makeHarness(t);
  const result = runCli(harness, ['-ps', 'missing']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown preset: missing/i);
  assert.equal(existsSync(harness.capture), false);
});
