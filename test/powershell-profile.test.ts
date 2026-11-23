import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installPowerShellProfiles,
  powerShellProfileCandidates,
  readProfileFile,
  removePowerShellProfiles,
  renderPowerShellBlock,
} from '../src/powershell-profile.ts';

const repoRoot = "/repo's dir/pi-presets";

function makeDir(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-presets-profile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('lists the computed profile candidates', () => {
  const candidates = powerShellProfileCandidates({
    env: { USERPROFILE: '/home/me', OneDrive: '/home/me/OneDrive' },
  });

  assert.deepEqual(candidates, [
    join('/home/me', 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    join('/home/me', 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    join('/home/me/OneDrive', 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    join('/home/me/OneDrive', 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
  ]);
});

test('omits OneDrive candidates when OneDrive is not set', () => {
  const candidates = powerShellProfileCandidates({ env: { USERPROFILE: 'C:\\Users\\me' } });
  assert.equal(candidates.length, 2);
});

test('refuses UTF-16 profiles instead of mangling them', (t) => {
  const directory = makeDir(t);
  const profile = join(directory, 'profile.ps1');
  writeFileSync(profile, Buffer.from('\uFEFFkeep me', 'utf16le'));

  assert.throws(() => readProfileFile(profile), /UTF-16/i);
  assert.throws(
    () => installPowerShellProfiles({ profilePaths: [profile], repoRoot }),
    /UTF-16/i,
  );
  assert.equal(readFileSync(profile).toString('utf16le'), '\uFEFFkeep me');
});

test('creates the profile with a BOM and CRLF and quotes single quotes', (t) => {
  const directory = makeDir(t);
  const profile = join(directory, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');

  assert.deepEqual(installPowerShellProfiles({ profilePaths: [profile], repoRoot }), [profile]);

  const bytes = readFileSync(profile);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8').slice(1);
  assert.ok(text.startsWith('# >>> pi-presets >>>\r\n'), text);
  assert.ok(text.includes("& node '/repo''s dir/pi-presets/src/cli.ts' @args"), text);
  assert.ok(text.endsWith('# <<< pi-presets <<<\r\n'), text);
});

test('install is idempotent and remove restores the original bytes', (t) => {
  const directory = makeDir(t);
  const profile = join(directory, 'profile.ps1');
  const original = 'before\r\nkeep this\r\nafter'; // 末尾无换行：已知且已接受的例外
  writeFileSync(profile, original);

  installPowerShellProfiles({ profilePaths: [profile], repoRoot });
  installPowerShellProfiles({ profilePaths: [profile], repoRoot });
  const installed = readFileSync(profile, 'utf8');
  assert.equal(installed.split('# >>> pi-presets >>>').length - 1, 1);
  assert.equal(installed.split('# <<< pi-presets <<<').length - 1, 1);

  assert.deepEqual(removePowerShellProfiles({ profilePaths: [profile] }), [profile]);
  assert.equal(readFileSync(profile, 'utf8'), `${original}\r\n`);
});

test('aborts before writing any profile when one is malformed', (t) => {
  const directory = makeDir(t);
  const good = join(directory, 'good.ps1');
  const broken = join(directory, 'broken.ps1');
  writeFileSync(broken, '# >>> pi-presets >>>\nleft open\n');

  assert.throws(
    () => installPowerShellProfiles({ profilePaths: [good, broken], repoRoot }),
    /incomplete managed block/i,
  );
  assert.equal(existsSync(good), false);
});

test('skips missing profiles on removal and leaves foreign profiles alone', (t) => {
  const directory = makeDir(t);
  const missing = join(directory, 'missing.ps1');
  const foreign = join(directory, 'foreign.ps1');
  writeFileSync(foreign, "# my own settings\r\nSet-Alias ll Get-ChildItem\r\n");

  assert.deepEqual(removePowerShellProfiles({ profilePaths: [missing, foreign] }), []);
  assert.equal(readFileSync(foreign, 'utf8'), "# my own settings\r\nSet-Alias ll Get-ChildItem\r\n");
});

test('removal strips a block from a CRLF file byte for byte', (t) => {
  const directory = makeDir(t);
  const profile = join(directory, 'profile.ps1');
  const original = 'before\r\n';
  writeFileSync(profile, original);
  installPowerShellProfiles({ profilePaths: [profile], repoRoot });

  removePowerShellProfiles({ profilePaths: [profile] });
  assert.equal(readFileSync(profile, 'utf8'), original);
});

test('removal restores an LF-only single-line profile that already ends with a newline', (t) => {
  const directory = makeDir(t);
  const profile = join(directory, 'profile.ps1');
  const original = 'before\n';
  writeFileSync(profile, original);
  installPowerShellProfiles({ profilePaths: [profile], repoRoot });

  const installed = readFileSync(profile, 'utf8');
  assert.ok(installed.startsWith('before\n\r\n# >>> pi-presets >>>\r\n'), installed);

  removePowerShellProfiles({ profilePaths: [profile] });
  assert.equal(readFileSync(profile, 'utf8'), original);
});

test('removal restores an LF-only profile that already ends with a newline', (t) => {
  const directory = makeDir(t);
  const profile = join(directory, 'profile.ps1');
  const original = 'before\nkeep this\n';
  writeFileSync(profile, original);
  installPowerShellProfiles({ profilePaths: [profile], repoRoot });

  assert.ok(readFileSync(profile, 'utf8').startsWith(`before\nkeep this\n\r\n# >>> pi-presets >>>\r\n`));
  removePowerShellProfiles({ profilePaths: [profile] });
  assert.equal(readFileSync(profile, 'utf8'), original);
});

test('renderPowerShellBlock wraps the generated function in markers', () => {
  const block = renderPowerShellBlock('/repo');
  assert.equal(block.split('\r\n')[0], '# >>> pi-presets >>>');
  assert.ok(block.includes('function pi {'));
  assert.equal(block.split('\r\n').at(-1), '# <<< pi-presets <<<');
});
