import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discoverPowerShellHosts,
  type PowerShellHost,
} from '../src/powershell-host.ts';
import {
  installPowerShellProfiles,
  powerShellProfileCandidates,
  removePowerShellProfiles,
} from '../src/powershell-profile.ts';

const setupPath = fileURLToPath(new URL('../src/setup.ts', import.meta.url));
const teardownPath = fileURLToPath(new URL('../src/teardown.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// Everything here drives the PowerShell hosts that are actually installed on the
// machine, which only exist on Windows. CI runs this file on windows-latest; on
// other platforms it is one skipped test.
const skip = process.platform !== 'win32' && 'real PowerShell hosts exist only on Windows';

const START = '# >>> pi-presets >>>';
const END = '# <<< pi-presets <<<';

type Snapshot = Map<string, Buffer | null>;

function snapshotProfile(profilePath: string): Snapshot {
  return new Map([[profilePath, existsSync(profilePath) ? readFileSync(profilePath) : null]]);
}

function restoreProfile(snapshots: readonly Snapshot[]): void {
  for (const snapshot of snapshots) {
    for (const [path, bytes] of snapshot) {
      if (bytes === null) {
        rmSync(path, { force: true });
      } else {
        writeFileSync(path, bytes);
      }
    }
  }
}

function hasUtf16Bom(bytes: Buffer): boolean {
  return (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

// A profile without a final newline gains one on install and keeps it after
// removal: that normalisation is the one accepted exception in the design.
function acceptableAfterRemoval(before: Buffer): Buffer[] {
  const candidates = [before];
  if (!before.subarray(before.length - 1).equals(Buffer.from('\n'))) {
    candidates.push(Buffer.concat([before, Buffer.from('\r\n')]));
  }
  return candidates;
}

function realHosts(): PowerShellHost[] {
  const { hosts, failures } = discoverPowerShellHosts({
    platform: 'win32',
    env: process.env,
    pathValue: process.env.PATH ?? '',
  });
  assert.ok(
    hosts.length > 0,
    `no PowerShell host found; failures: ${failures.map((failure) => failure.message).join('; ') || 'none'}`,
  );
  return hosts;
}

test('discovers the machine’s real PowerShell hosts and their $PROFILE', { skip }, () => {
  for (const host of realHosts()) {
    assert.equal(host.kind === 'pwsh' || host.kind === 'windows-powershell', true);
    assert.match(host.profilePath, /Microsoft\.PowerShell_profile\.ps1$/i);
    assert.match(host.profilePath, /^[A-Za-z]:\\/, host.profilePath);
  }
});

test('install then remove round-trips each real profile', { skip }, () => {
  for (const host of realHosts()) {
    if (existsSync(host.profilePath) && hasUtf16Bom(readFileSync(host.profilePath))) continue;

    const snapshot = snapshotProfile(host.profilePath);
    try {
      installPowerShellProfiles({
        profilePaths: [host.profilePath],
        repoRoot: './repo-with-temp-path',
      });
      const installed = readFileSync(host.profilePath, 'utf8');
      assert.ok(installed.includes(START), `${host.kind}: missing start marker`);
      assert.ok(installed.includes(END), `${host.kind}: missing end marker`);
      assert.ok(installed.includes('function pi {'), `${host.kind}: missing function`);

      assert.deepEqual(
        removePowerShellProfiles({ profilePaths: [host.profilePath] }),
        [host.profilePath],
      );
      const after = existsSync(host.profilePath) ? readFileSync(host.profilePath) : Buffer.alloc(0);
      assert.equal(after.includes(START), false, `${host.kind}: start marker survived teardown`);
      assert.equal(after.includes(END), false, `${host.kind}: end marker survived teardown`);

      const before = snapshot.get(host.profilePath) ?? null;
      if (before === null) {
        // setup created the file; teardown may leave the UTF-8 BOM behind.
        assert.ok(
          after.equals(Buffer.alloc(0)) || after.equals(Buffer.from([0xef, 0xbb, 0xbf])),
          `${host.kind}: unexpected leftovers ${JSON.stringify(after.toString('utf8'))}`,
        );
      } else {
        assert.ok(
          acceptableAfterRemoval(before).some((expected) => expected.equals(after)),
          `${host.kind}: profile bytes were not restored`,
        );
      }
    } finally {
      restoreProfile([snapshot]);
    }
  }
});

test('setup and teardown work through the real CLI on this machine', { skip }, () => {
  const hosts = realHosts();
  const snapshots = hosts.map((host) => snapshotProfile(host.profilePath));
  const candidates = powerShellProfileCandidates({ env: process.env });
  const candidateSnapshots = candidates.filter((path) => existsSync(path)).map(snapshotProfile);

  try {
    const setup = spawnSync(process.execPath, [setupPath, '--shell', 'powershell'], {
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /Installed pi-presets integration for powershell:/);
    assert.match(setup.stdout, /function picode \{ pi -ps coding @args \}/);
    for (const host of hosts) {
      assert.ok(readFileSync(host.profilePath, 'utf8').includes(START), `${host.kind}: setup wrote no block`);
    }

    const teardown = spawnSync(process.execPath, [teardownPath], {
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(teardown.status, 0, teardown.stderr);
    const remaining = [...hosts.map((host) => host.profilePath), ...candidates];
    for (const path of remaining) {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      assert.equal(text.includes(START), false, `${path}: start marker survived teardown`);
      assert.equal(text.includes(END), false, `${path}: end marker survived teardown`);
    }
  } finally {
    restoreProfile([...snapshots, ...candidateSnapshots]);
    rmSync(join(repoRoot, '.superpowers'), { recursive: true, force: true });
  }
});
