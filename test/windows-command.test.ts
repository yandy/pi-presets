import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCmdCommandLine,
  quoteForCmd,
  resolveRealPi,
  spawnSpec,
} from '../src/windows-command.ts';

const PATH_EXT = '.COM;.EXE;.BAT;.CMD';

function makeDir(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-presets-win-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function touch(path: string): void {
  writeFileSync(path, 'x');
  chmodSync(path, 0o755);
}

test('POSIX keeps the existing lookup', (t) => {
  const directory = makeDir(t);
  touch(join(directory, 'pi'));

  assert.deepEqual(
    resolveRealPi({ pathValue: directory, platform: 'linux', pathExt: PATH_EXT }),
    { path: join(directory, 'pi'), kind: 'direct' },
  );
});

test('Windows follows PATHEXT and skips the extensionless sh script', (t) => {
  const directory = makeDir(t);
  touch(join(directory, 'pi'));
  touch(join(directory, 'pi.cmd'));

  assert.deepEqual(
    resolveRealPi({ pathValue: directory, platform: 'win32', pathExt: PATH_EXT }),
    { path: join(directory, 'pi.cmd'), kind: 'cmd' },
  );
});

test('Windows prefers earlier PATH entries and earlier PATHEXT entries', (t) => {
  const first = makeDir(t);
  const second = makeDir(t);
  touch(join(first, 'pi.exe'));
  touch(join(second, 'pi.cmd'));

  assert.equal(
    resolveRealPi({ pathValue: `${first};${second}`, platform: 'win32', pathExt: PATH_EXT }).path,
    join(first, 'pi.exe'),
  );

  rmSync(join(first, 'pi.exe'));
  touch(join(first, 'pi.cmd'));
  touch(join(first, 'pi.bat'));
  assert.equal(
    resolveRealPi({ pathValue: first, platform: 'win32', pathExt: '.BAT;.CMD;.EXE' }).path,
    join(first, 'pi.bat'),
  );
});

test('reports a missing pi with the searched names', (t) => {
  const directory = makeDir(t);
  assert.throws(
    () => resolveRealPi({ pathValue: directory, platform: 'win32', pathExt: PATH_EXT }),
    /pi is not on PATH.*pi\.exe.*pi\.cmd/i,
  );
});

test('quotes arguments for cmd', () => {
  assert.equal(quoteForCmd(''), '""');
  assert.equal(quoteForCmd('plain'), 'plain');
  assert.equal(quoteForCmd('two words'), '"two words"');
  assert.equal(quoteForCmd('a&b'), 'a^&b');
  assert.equal(quoteForCmd('a&b c'), '"a&b c"');
  assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteForCmd('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(quoteForCmd('100%'), '100%');
  assert.equal(quoteForCmd('bang!'), 'bang!');
  assert.equal(quoteForCmd('中文'), '中文');
});

test('builds a /s command line that survives spaces', (t) => {
  const directory = makeDir(t);
  touch(join(directory, 'pi.cmd'));
  const command = resolveRealPi({ pathValue: directory, platform: 'win32', pathExt: PATH_EXT });

  assert.equal(
    buildCmdCommandLine(command, ['-ps', 'coding', '-p', 'list ts files']),
    `""${join(directory, 'pi.cmd')}" -ps coding -p "list ts files""`,
  );
});

test('spawns .cmd through the command processor and .exe directly', (t) => {
  const directory = makeDir(t);
  const exe = join(directory, 'pi.exe');
  touch(exe);

  assert.deepEqual(spawnSpec({ path: exe, kind: 'direct' }, ['-ps', 'coding']), {
    file: exe,
    args: ['-ps', 'coding'],
    windowsVerbatimArguments: false,
  });

  const cmd = { path: join(directory, 'pi.cmd'), kind: 'cmd' as const };
  const spec = spawnSpec(cmd, ['-ps', 'coding']);
  assert.match(spec.file, /cmd\.exe$/i);
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
});
