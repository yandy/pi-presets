import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverPowerShellHosts,
  PROFILE_QUERY_COMMAND,
  type DiscoverPowerShellHostsOptions,
} from '../src/powershell-host.ts';

function makeDir(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-presets-host-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// The fake hosts are POSIX shell scripts, so the cases that spawn them cannot
// run on Windows. The cases that inject `query` are platform-neutral and skip
// nothing.
const posixFakeHostsSkip = process.platform === 'win32'
  && 'fake hosts are POSIX scripts; real hosts are covered by windows-smoke.test.ts';

// 假宿主：忽略参数，直接打印一个路径，模拟 `$PROFILE`。
function writeFakeHost(directory: string, name: string, profilePath: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${profilePath}'\n`);
  chmodSync(path, 0o755);
  return path;
}

test('returns nothing off Windows', () => {
  const result = discoverPowerShellHosts({
    platform: 'linux',
    env: {},
    pathValue: '/usr/bin',
  });
  assert.deepEqual(result, { hosts: [], failures: [] });
});

test('discovers pwsh on PATH and uses its $PROFILE', { skip: posixFakeHostsSkip }, (t) => {
  const directory = makeDir(t);
  const profilePath = join(directory, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
  writeFakeHost(directory, 'pwsh.exe', profilePath);

  const result = discoverPowerShellHosts({
    platform: 'win32',
    env: {},
    pathValue: directory,
  });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.hosts, [
    { kind: 'pwsh', executable: join(directory, 'pwsh.exe'), profilePath },
  ]);
});

test('discovers both hosts, pwsh first', { skip: posixFakeHostsSkip }, (t) => {
  const directory = makeDir(t);
  writeFakeHost(directory, 'pwsh.exe', 'C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1');
  writeFakeHost(directory, 'powershell.exe', 'C:\\Users\\me\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1');

  const result = discoverPowerShellHosts({ platform: 'win32', env: {}, pathValue: directory });

  assert.deepEqual(result.hosts.map((host) => host.kind), ['pwsh', 'windows-powershell']);
});

test('falls back to the known install locations', { skip: posixFakeHostsSkip }, (t) => {
  const directory = makeDir(t);
  const programFiles = join(directory, 'Program Files');
  const systemRoot = join(directory, 'Windows');
  const pwsh = join(programFiles, 'PowerShell', '7');
  const winPs = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  mkdirSync(pwsh, { recursive: true });
  mkdirSync(winPs, { recursive: true });
  writeFakeHost(pwsh, 'pwsh.exe', 'C:\\pwsh-profile.ps1');
  writeFakeHost(winPs, 'powershell.exe', 'C:\\winps-profile.ps1');

  const result = discoverPowerShellHosts({
    platform: 'win32',
    env: { ProgramFiles: programFiles, SystemRoot: systemRoot },
    pathValue: join(directory, 'empty'),
  });

  assert.deepEqual(result.hosts.map((host) => host.profilePath), [
    'C:\\pwsh-profile.ps1',
    'C:\\winps-profile.ps1',
  ]);
});

test('records a failure and keeps the host that answered', (t) => {
  const directory = makeDir(t);
  writeFakeHost(directory, 'pwsh.exe', 'ignored');
  writeFakeHost(directory, 'powershell.exe', 'ignored');

  const query = (executable: string): string => {
    if (executable.endsWith('pwsh.exe')) throw new Error('timed out');
    return 'C:\\Users\\me\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1';
  };

  const result = discoverPowerShellHosts({ platform: 'win32', env: {}, pathValue: directory, query });

  assert.deepEqual(result.hosts.map((host) => host.kind), ['windows-powershell']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].kind, 'pwsh');
  assert.match(result.failures[0].message, /timed out/);
});

test('treats empty $PROFILE output as a failure', (t) => {
  const directory = makeDir(t);
  writeFakeHost(directory, 'pwsh.exe', 'ignored');

  const result = discoverPowerShellHosts({
    platform: 'win32',
    env: {},
    pathValue: directory,
    query: () => '   \r\n',
  });

  assert.deepEqual(result.hosts, []);
  assert.match(result.failures[0].message, /\$PROFILE/i);
});

test('calls the injected query with the resolved executable', (t) => {
  const directory = makeDir(t);
  const executable = writeFakeHost(directory, 'pwsh.exe', 'C:\\profile.ps1');
  const seen: string[] = [];

  const options: DiscoverPowerShellHostsOptions = {
    platform: 'win32',
    env: {},
    pathValue: directory,
    query: (path) => {
      seen.push(path);
      return 'C:\\profile.ps1';
    },
  };
  discoverPowerShellHosts(options);

  assert.deepEqual(seen, [executable]);
  assert.match(PROFILE_QUERY_COMMAND, /^\s*\[Console\]::OutputEncoding/);
  assert.match(PROFILE_QUERY_COMMAND, /\$PROFILE$/);
});
