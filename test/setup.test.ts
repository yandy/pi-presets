import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installShellIntegration,
  removeShellIntegration,
  renderFunctionSource,
  shellIntegrationPaths,
} from '../src/shell-integration.ts';

import { envWith, pathOverride } from './env.ts';

const setupPath = fileURLToPath(new URL('../src/setup.ts', import.meta.url));
const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const powershellHostPath = fileURLToPath(new URL('../src/powershell-host.ts', import.meta.url));
const teardownPath = fileURLToPath(new URL('../src/teardown.ts', import.meta.url));

// Several Windows cases stand in for pwsh.exe/powershell.exe with POSIX shell
// scripts, which Windows cannot execute. The real hosts are covered instead by
// test/windows-smoke.test.ts, which runs only on Windows.
const windowsFakeHostsSkip = process.platform === 'win32'
  && 'fake hosts are POSIX scripts; real hosts are covered by windows-smoke.test.ts';

interface TestDirectories {
  directory: string;
  homeDir: string;
  configHome: string;
}

function makeDirectories(t: TestContext): TestDirectories {
  const directory = mkdtempSync(join(tmpdir(), 'pi-presets-setup-'));
  const homeDir = join(directory, 'home');
  const configHome = join(homeDir, '.config');
  mkdirSync(homeDir, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, homeDir, configHome };
}

test('installs fish integration into conf.d', (t) => {
  const directories = makeDirectories(t);
  const result = installShellIntegration({
    shell: 'fish',
    repoRoot: directories.directory,
    ...directories,
  });
  const expected = join(directories.configHome, 'fish', 'conf.d', 'pi-presets.fish');

  assert.deepEqual(result, { files: [expected] });
  assert.ok(existsSync(expected));
});

for (const shell of ['bash', 'zsh'] as const) {
  test(`installs ${shell} integration idempotently and preserves rc content`, (t) => {
    const directories = makeDirectories(t);
    const rcPath = join(directories.homeDir, `.${shell}rc`);
    writeFileSync(rcPath, `before ${shell}\nkeep this line\nafter ${shell}\n`);
    const options = {
      shell,
      repoRoot: directories.directory,
      ...directories,
    };

    installShellIntegration(options);
    installShellIntegration(options);

    const rc = readFileSync(rcPath, 'utf8');
    assert.ok(rc.startsWith(`before ${shell}\nkeep this line\nafter ${shell}\n`));
    assert.equal(rc.split('# >>> pi-presets >>>').length - 1, 1);
    assert.equal(rc.split('# <<< pi-presets <<<').length - 1, 1);
    const functionPath = join(directories.configHome, 'pi-presets', 'pi.sh');
    assert.equal(rc.split(functionPath).length - 1, 2);
    assert.ok(existsSync(functionPath));
  });
}

test('rejects an incomplete managed rc block without modifying it', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  const original = 'keep me\n# >>> pi-presets >>>\nold content\n';
  writeFileSync(rcPath, original);

  assert.throws(() => installShellIntegration({
    shell: 'bash',
    repoRoot: directories.directory,
    ...directories,
  }), /incomplete managed block/i);
  assert.equal(readFileSync(rcPath, 'utf8'), original);
});

test('setup detects SHELL and prints the reload instruction', (t) => {
  const directories = makeDirectories(t);
  const result = spawnSync(process.execPath, [setupPath], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'linux',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/usr/bin/fish',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(
    directories.configHome, 'fish', 'conf.d', 'pi-presets.fish',
  )));
  assert.match(result.stdout, /exec "\$SHELL"/);
});

test('setup accepts an explicit shell override', (t) => {
  const directories = makeDirectories(t);
  const result = spawnSync(process.execPath, [setupPath, '--shell', 'bash'], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'linux',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/usr/bin/fish',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(directories.homeDir, '.bashrc')));
  assert.match(result.stdout, /source .*\.bashrc/);
});

for (const [shell, shortcut, multiPresetShortcut] of [
  ['fish', "abbr --add picode 'pi -ps coding'", "abbr --add piwork 'pi -ps office,design'"],
  ['bash', "alias picode='pi -ps coding'", "alias piwork='pi -ps office,design'"],
  ['zsh', "alias picode='pi -ps coding'", "alias piwork='pi -ps office,design'"],
] as const) {
  test(`setup prints the ${shell} shortcut hint after installing`, (t) => {
    const directories = makeDirectories(t);
    const result = spawnSync(process.execPath, [setupPath, '--shell', shell], {
      env: {
        ...process.env,
        PI_PRESETS_PLATFORM: 'linux',
        HOME: directories.homeDir,
        XDG_CONFIG_HOME: directories.configHome,
        SHELL: '/usr/bin/fish',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(shortcut), result.stdout);
    assert.ok(result.stdout.includes(multiPresetShortcut), result.stdout);
    const otherDefinition = shell === 'fish'
      ? "alias picode='pi -ps coding'"
      : "abbr --add picode 'pi -ps coding'";
    assert.ok(!result.stdout.includes(otherDefinition), result.stdout);
  });
}

test('setup --dry-run keeps the shortcut hint out of the evaluated output', (t) => {
  const directories = makeDirectories(t);
  const result = spawnSync(process.execPath, [setupPath, '--dry-run', '--shell', 'fish'], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'linux',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/usr/bin/fish',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, renderFunctionSource('fish', repoRoot));
});

test('setup rejects unsupported shells and missing option values', (t) => {
  const directories = makeDirectories(t);
  const env = {
    ...process.env,
    PI_PRESETS_PLATFORM: 'linux',
    HOME: directories.homeDir,
    XDG_CONFIG_HOME: directories.configHome,
    SHELL: '/usr/bin/nu',
  };
  const unsupported = spawnSync(process.execPath, [setupPath], { env, encoding: 'utf8' });
  const missing = spawnSync(
    process.execPath,
    [setupPath, '--shell'],
    { env: { ...env, SHELL: '/usr/bin/bash' }, encoding: 'utf8' },
  );

  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /unsupported shell/i);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--shell requires/i);
});

for (const shell of ['fish', 'bash', 'zsh'] as const) {
  const shellLookup = spawnSync(
    'sh',
    ['-c', 'command -v "$1"', 'shell-lookup', shell],
    { encoding: 'utf8' },
  );
  const shellPath = (shellLookup.stdout ?? '').trim();
  test(`generated ${shell} function works from a path with shell metacharacters`, {
    skip: process.platform === 'win32' || shellLookup.status !== 0,
    timeout: 5000,
  }, (t) => {
    const directories = makeDirectories(t);
    const repoRoot = join(directories.directory, "repo with ' quote and $dollar");
    const bin = join(directories.directory, 'bin');
    const cwd = join(directories.directory, 'work');
    const capture = join(directories.directory, `${shell}-capture.json`);
    mkdirSync(bin);
    mkdirSync(cwd);
    // The fake Pi is an extensionless CommonJS script, so pin its module type:
    // a stray package.json above the temp dir (/tmp/package.json says
    // "type": "module") would otherwise make Node load it as ESM.
    writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}\n');
    mkdirSync(join(repoRoot, 'coding'), { recursive: true });
    cpSync(sourceDirectory, join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'coding', 'package.json'), '{"name":"coding"}');

    const fakePi = join(bin, 'pi');
    writeFileSync(fakePi, `#!${process.execPath}\n`
      + "const fs = require('node:fs');\n"
      + 'fs.writeFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({\n'
      + '  argv: process.argv.slice(2), cwd: process.cwd(),\n'
      + '}));\n');
    chmodSync(fakePi, 0o755);

    installShellIntegration({ shell, repoRoot, ...directories });
    const integrationPath = shell === 'fish'
      ? join(directories.configHome, 'fish', 'conf.d', 'pi-presets.fish')
      : join(directories.configHome, 'pi-presets', 'pi.sh');
    const script = shell === 'fish'
      ? 'source $argv[1]; pi -ps coding -p hello'
      : 'source "$1"; pi -ps coding -p hello';
    const args = shell === 'fish'
      ? ['-c', script, integrationPath]
      : ['-c', script, 'pi-presets-test', integrationPath];
    const result = spawnSync(shellPath, args, {
      cwd,
      env: {
        ...process.env,
        PI_PRESETS_PLATFORM: 'linux',
        HOME: directories.homeDir,
        XDG_CONFIG_HOME: directories.configHome,
        SHELL: shellPath,
        ...pathOverride(`${bin}${delimiter}${dirname(process.execPath)}`),
        FAKE_PI_CAPTURE: capture,
      },
      encoding: 'utf8',
      timeout: 4000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      argv: ['-e', join(repoRoot, 'coding'), '-p', 'hello'],
      cwd,
    });
  });
}

test('renderFunctionSource matches the installed function file', (t) => {
  const directories = makeDirectories(t);
  installShellIntegration({ shell: 'bash', repoRoot: '/repo with space', ...directories });
  assert.equal(
    readFileSync(join(directories.configHome, 'pi-presets', 'pi.sh'), 'utf8'),
    renderFunctionSource('bash', '/repo with space'),
  );
});

test('shellIntegrationPaths lists exactly what install reports', (t) => {
  const directories = makeDirectories(t);
  for (const shell of ['fish', 'bash', 'zsh'] as const) {
    const options = { shell, repoRoot: directories.directory, ...directories };
    assert.deepEqual(
      installShellIntegration(options).files,
      shellIntegrationPaths(shell, directories.homeDir, directories.configHome),
    );
  }
});

test('removing integration restores the rc file byte for byte', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  const original = 'before\nkeep this\nafter\n';
  writeFileSync(rcPath, original);
  const install = { shell: 'bash' as const, repoRoot: directories.directory, ...directories };
  installShellIntegration(install);
  installShellIntegration(install);

  const result = removeShellIntegration({
    shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome,
  });

  assert.equal(readFileSync(rcPath, 'utf8'), original);
  assert.deepEqual(result.rcFiles, [rcPath]);
  assert.deepEqual(result.files, [join(directories.configHome, 'pi-presets', 'pi.sh')]);
  assert.ok(!existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
});

test('removing integration leaves no managed block for a missing or empty rc', (t) => {
  const directories = makeDirectories(t);
  for (const shell of ['bash', 'zsh'] as const) {
    installShellIntegration({ shell, repoRoot: directories.directory, ...directories });
    removeShellIntegration({
      shells: [shell], homeDir: directories.homeDir, configHome: directories.configHome,
    });
    const rcPath = join(directories.homeDir, `.${shell}rc`);
    assert.ok(existsSync(rcPath));
    assert.equal(readFileSync(rcPath, 'utf8'), '');
  }
});

test('removing integration preserves content that follows the managed block', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  writeFileSync(rcPath, 'before\n# >>> pi-presets >>>\nold\n# <<< pi-presets <<<\nkeep me\n');

  removeShellIntegration({
    shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome,
  });

  assert.equal(readFileSync(rcPath, 'utf8'), 'before\nkeep me\n');
});

test('removing integration aborts on an incomplete managed block', (t) => {
  const directories = makeDirectories(t);
  const bashrc = join(directories.homeDir, '.bashrc');
  const zshrc = join(directories.homeDir, '.zshrc');
  const original = 'keep me\n# >>> pi-presets >>>\nold\n';
  writeFileSync(bashrc, original);
  writeFileSync(zshrc, 'zsh content\n');
  installShellIntegration({ shell: 'zsh', repoRoot: directories.directory, ...directories });

  assert.throws(() => removeShellIntegration({
    shells: ['bash', 'zsh'], homeDir: directories.homeDir, configHome: directories.configHome,
  }), /incomplete managed block/i);
  assert.equal(readFileSync(bashrc, 'utf8'), original);
  assert.match(readFileSync(zshrc, 'utf8'), /# >>> pi-presets >>>/);
});

test('keeps the shared posix function file while another rc still references it', (t) => {
  const directories = makeDirectories(t);
  for (const shell of ['bash', 'zsh'] as const) {
    installShellIntegration({ shell, repoRoot: directories.directory, ...directories });
  }
  const functionPath = join(directories.configHome, 'pi-presets', 'pi.sh');

  const result = removeShellIntegration({
    shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome,
  });

  assert.ok(existsSync(functionPath));
  assert.deepEqual(result.keptFiles, [functionPath]);
  assert.doesNotMatch(readFileSync(join(directories.homeDir, '.bashrc'), 'utf8'), /pi-presets/);
  assert.match(readFileSync(join(directories.homeDir, '.zshrc'), 'utf8'), /# >>> pi-presets >>>/);
});

test('removing fish integration deletes only the conf.d file', (t) => {
  const directories = makeDirectories(t);
  installShellIntegration({ shell: 'fish', repoRoot: directories.directory, ...directories });
  const integrationPath = join(directories.configHome, 'fish', 'conf.d', 'pi-presets.fish');

  const result = removeShellIntegration({
    shells: ['fish'], homeDir: directories.homeDir, configHome: directories.configHome,
  });

  assert.deepEqual(result.files, [integrationPath]);
  assert.ok(!existsSync(integrationPath));
  assert.ok(existsSync(join(directories.configHome, 'fish', 'conf.d')));
});

test('dry run reports the plan without touching any file', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  installShellIntegration({ shell: 'bash', repoRoot: directories.directory, ...directories });
  const installed = readFileSync(rcPath, 'utf8');

  const result = removeShellIntegration({
    shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome, dryRun: true,
  });

  assert.deepEqual(result.rcFiles, [rcPath]);
  assert.equal(readFileSync(rcPath, 'utf8'), installed);
  assert.ok(existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
});

test('setup --dry-run prints the function source and writes nothing', (t) => {
  const directories = makeDirectories(t);
  const result = spawnSync(process.execPath, [setupPath, '--dry-run', '--shell', 'bash'], {
    env: { ...process.env,
      PI_PRESETS_PLATFORM: 'linux', HOME: directories.homeDir, XDG_CONFIG_HOME: directories.configHome, SHELL: '/bin/fish' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, renderFunctionSource('bash', repoRoot));
  assert.ok(!existsSync(join(directories.homeDir, '.bashrc')));
  assert.ok(!existsSync(join(directories.configHome, 'pi-presets')));
  assert.match(result.stderr, /dry run/i);
});

const bashLookup = spawnSync('sh', ['-c', 'command -v "$1"', 'shell-lookup', 'bash'], { encoding: 'utf8' });
const bashPath = (bashLookup.stdout ?? '').trim();

test('setup --dry-run output evaluates into a working function', {
  skip: process.platform === 'win32' || bashLookup.status !== 0,
  timeout: 5000,
}, (t) => {
  const directories = makeDirectories(t);
  const repoRootWithQuotes = join(directories.directory, "repo with ' quote and $dollar");
  const bin = join(directories.directory, 'bin');
  const cwd = join(directories.directory, 'work');
  const capture = join(directories.directory, 'capture.json');
  mkdirSync(bin);
  mkdirSync(cwd);
  // See the module-type note above: the fake Pi fixture must stay CommonJS.
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}\n');
  mkdirSync(join(repoRootWithQuotes, 'coding'), { recursive: true });
  cpSync(sourceDirectory, join(repoRootWithQuotes, 'src'), { recursive: true });
  writeFileSync(join(repoRootWithQuotes, 'coding', 'package.json'), '{"name":"coding"}');
  const fakePi = join(bin, 'pi');
  writeFileSync(fakePi, `#!${process.execPath}\n`
    + "const fs = require('node:fs');\n"
    + 'fs.writeFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n');
  chmodSync(fakePi, 0o755);

  const dryRun = spawnSync(
    process.execPath,
    [join(repoRootWithQuotes, 'src', 'setup.ts'), '--dry-run', '--shell', 'bash'],
    { env: { ...process.env,
      PI_PRESETS_PLATFORM: 'linux', HOME: directories.homeDir, XDG_CONFIG_HOME: directories.configHome }, encoding: 'utf8' },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);

  const result = spawnSync(bashPath, ['-c', 'eval "$1"; pi -ps coding -p hello', 'pi-presets-test', dryRun.stdout], {
    cwd,
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'linux',
      HOME: directories.homeDir,
      ...pathOverride(`${bin}${delimiter}${dirname(process.execPath)}`),
      FAKE_PI_CAPTURE: capture,
    },
    encoding: 'utf8',
    timeout: 4000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
    argv: ['-e', join(repoRootWithQuotes, 'coding'), '-p', 'hello'],
    cwd,
  });
});

function runTeardown(directories: TestDirectories, args: readonly string[]) {
  return spawnSync(process.execPath, [teardownPath, ...args], {
    env: { ...process.env,
      PI_PRESETS_PLATFORM: 'linux', HOME: directories.homeDir, XDG_CONFIG_HOME: directories.configHome, SHELL: '/bin/fish' },
    encoding: 'utf8',
  });
}

test('teardown removes every registration by default', (t) => {
  const directories = makeDirectories(t);
  const rcPaths = ['bash', 'zsh'].map((shell) => join(directories.homeDir, `.${shell}rc`));
  for (const shell of ['fish', 'bash', 'zsh'] as const) {
    installShellIntegration({ shell, repoRoot: directories.directory, ...directories });
  }

  const result = runTeardown(directories, []);

  assert.equal(result.status, 0, result.stderr);
  for (const rcPath of rcPaths) assert.equal(readFileSync(rcPath, 'utf8'), '');
  assert.ok(!existsSync(join(directories.configHome, 'fish', 'conf.d', 'pi-presets.fish')));
  assert.ok(!existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
  assert.ok(!existsSync(join(directories.configHome, 'pi-presets')));
});

test('teardown is a no-op when nothing is installed', (t) => {
  const directories = makeDirectories(t);
  const result = runTeardown(directories, []);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to remove/i);
});

test('teardown --shell bash keeps the shared function file for zsh', (t) => {
  const directories = makeDirectories(t);
  for (const shell of ['bash', 'zsh'] as const) {
    installShellIntegration({ shell, repoRoot: directories.directory, ...directories });
  }

  const result = runTeardown(directories, ['--shell', 'bash']);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
  assert.match(result.stdout, /pi\.sh/);
  assert.match(readFileSync(join(directories.homeDir, '.zshrc'), 'utf8'), /# >>> pi-presets >>>/);
});

test('teardown --dry-run changes nothing', (t) => {
  const directories = makeDirectories(t);
  installShellIntegration({ shell: 'bash', repoRoot: directories.directory, ...directories });
  const installed = readFileSync(join(directories.homeDir, '.bashrc'), 'utf8');

  const result = runTeardown(directories, ['--shell', 'bash', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry run/i);
  assert.equal(readFileSync(join(directories.homeDir, '.bashrc'), 'utf8'), installed);
  assert.ok(existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
});

test('teardown rejects unknown options and unsupported shells', (t) => {
  const directories = makeDirectories(t);

  assert.equal(runTeardown(directories, ['--force']).status, 2);
  assert.equal(runTeardown(directories, ['--shell']).status, 2);
  const unsupported = runTeardown(directories, ['--shell', 'nu']);
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /unsupported shell/i);
});

const fishLookup = spawnSync('sh', ['-c', 'command -v "$1"', 'shell-lookup', 'fish'], { encoding: 'utf8' });
const fishPath = (fishLookup.stdout ?? '').trim();

test('removing integration aborts on duplicate or stray managed markers', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  const fixtures = [
    'before\n# >>> pi-presets >>>\nold\n# >>> pi-presets >>>\nuser line\n# <<< pi-presets <<<\nafter\n',
    'before\n# >>> pi-presets >>>\nold\n# <<< pi-presets <<<\nafter\n# >>> pi-presets >>>\n',
  ];
  installShellIntegration({ shell: 'zsh', repoRoot: directories.directory, ...directories });
  const functionPath = join(directories.configHome, 'pi-presets', 'pi.sh');
  const installedFunction = readFileSync(functionPath, 'utf8');

  for (const original of fixtures) {
    writeFileSync(rcPath, original);
    assert.throws(() => removeShellIntegration({
      shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome,
    }), /managed block/i);
    assert.equal(readFileSync(rcPath, 'utf8'), original);
    assert.equal(readFileSync(functionPath, 'utf8'), installedFunction);
  }
});

test('teardown exits 1 without writing when the managed block is malformed', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  const original = 'before\n# >>> pi-presets >>>\nold\n# >>> pi-presets >>>\nuser line\n# <<< pi-presets <<<\nafter\n';
  installShellIntegration({ shell: 'bash', repoRoot: directories.directory, ...directories });
  writeFileSync(rcPath, original);

  const result = runTeardown(directories, ['--shell', 'bash']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /managed block/i);
  assert.equal(readFileSync(rcPath, 'utf8'), original);
  assert.ok(existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
});

test('removing integration normalizes a missing final newline', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  writeFileSync(rcPath, 'no trailing newline');
  const options = { shell: 'bash' as const, repoRoot: directories.directory, ...directories };

  installShellIntegration(options);
  removeShellIntegration({
    shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome,
  });

  assert.equal(readFileSync(rcPath, 'utf8'), 'no trailing newline\n');
});

test('reinstalling after removal reproduces the same rc bytes', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  writeFileSync(rcPath, 'keep\nme\n');
  const options = { shell: 'bash' as const, repoRoot: directories.directory, ...directories };

  installShellIntegration(options);
  const installed = readFileSync(rcPath, 'utf8');
  removeShellIntegration({
    shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome,
  });
  assert.equal(readFileSync(rcPath, 'utf8'), 'keep\nme\n');
  installShellIntegration(options);

  assert.equal(readFileSync(rcPath, 'utf8'), installed);
});

test('a second teardown removes nothing', (t) => {
  const directories = makeDirectories(t);
  installShellIntegration({ shell: 'bash', repoRoot: directories.directory, ...directories });

  assert.equal(runTeardown(directories, []).status, 0);
  const second = runTeardown(directories, []);

  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /nothing to remove/i);
});

test('setup --dry-run output evaluates in fish with string collect', {
  skip: fishLookup.status !== 0,
  timeout: 5000,
}, (t) => {
  const directories = makeDirectories(t);
  const repoRootWithQuotes = join(directories.directory, "repo with ' quote and $dollar");
  const bin = join(directories.directory, 'bin');
  const cwd = join(directories.directory, 'work');
  const capture = join(directories.directory, 'fish-capture.json');
  mkdirSync(bin);
  mkdirSync(cwd);
  // See the module-type note above: the fake Pi fixture must stay CommonJS.
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}\n');
  mkdirSync(join(repoRootWithQuotes, 'coding'), { recursive: true });
  cpSync(sourceDirectory, join(repoRootWithQuotes, 'src'), { recursive: true });
  writeFileSync(join(repoRootWithQuotes, 'coding', 'package.json'), '{"name":"coding"}');
  const fakePi = join(bin, 'pi');
  writeFileSync(fakePi, `#!${process.execPath}\n`
    + "const fs = require('node:fs');\n"
    + 'fs.writeFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n');
  chmodSync(fakePi, 0o755);

  const result = spawnSync(fishPath, [
    '-c',
    'eval (node $argv[1] --dry-run --shell fish | string collect); pi -ps coding -p hello',
    join(repoRootWithQuotes, 'src', 'setup.ts'),
  ], {
    cwd,
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'linux',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      ...pathOverride(`${bin}${delimiter}${dirname(process.execPath)}`),
      FAKE_PI_CAPTURE: capture,
    },
    encoding: 'utf8',
    timeout: 4000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
    argv: ['-e', join(repoRootWithQuotes, 'coding'), '-p', 'hello'],
    cwd,
  });
});

test('setup writes both host profiles on Windows', { skip: windowsFakeHostsSkip }, (t) => {
  const directories = makeDirectories(t);
  const hosts = join(directories.directory, 'hosts');
  mkdirSync(hosts, { recursive: true });
  for (const [name, profile] of [
    ['pwsh.exe', join(directories.directory, 'ps7', 'Microsoft.PowerShell_profile.ps1')],
    ['powershell.exe', join(directories.directory, 'ps51', 'Microsoft.PowerShell_profile.ps1')],
  ]) {
    const path = join(hosts, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${profile}'\n`);
    chmodSync(path, 0o755);
  }

  const result = spawnSync(process.execPath, [setupPath], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/bin/bash',
      USERPROFILE: directories.homeDir,
      ...pathOverride(`${hosts};${process.env.PATH ?? ''}`),
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(directories.directory, 'ps7', 'Microsoft.PowerShell_profile.ps1')));
  assert.ok(existsSync(join(directories.directory, 'ps51', 'Microsoft.PowerShell_profile.ps1')));
  assert.match(result.stdout, /function picode \{ pi -ps coding @args \}/);
});

test('setup rejects powershell off Windows and fish on Windows', (t) => {
  const directories = makeDirectories(t);
  const offWindows = spawnSync(process.execPath, [setupPath, '--shell', 'powershell'], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'linux',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/bin/bash',
    },
    encoding: 'utf8',
  });
  const onWindows = spawnSync(process.execPath, [setupPath, '--shell', 'fish'], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/bin/bash',
      USERPROFILE: directories.homeDir,
    },
    encoding: 'utf8',
  });

  assert.equal(offWindows.status, 2);
  assert.match(offWindows.stderr, /not supported on this platform/i);
  assert.equal(onWindows.status, 2);
  assert.match(onWindows.stderr, /powershell/i);
});

test('setup fails when no PowerShell host is found', (t) => {
  const directories = makeDirectories(t);
  // envWith drops case variants of the keys below: Windows environment blocks
  // can carry `SYSTEMROOT`/`ProgramFiles` in another casing, and a duplicate
  // entry would let discovery find the machine's real host.
  const env = envWith(process.env, {
    PI_PRESETS_PLATFORM: 'win32',
    HOME: directories.homeDir,
    XDG_CONFIG_HOME: directories.configHome,
    SHELL: '/bin/bash',
    USERPROFILE: directories.homeDir,
    ProgramFiles: join(directories.directory, 'none'),
    SystemRoot: join(directories.directory, 'none'),
    ...pathOverride(join(directories.directory, 'empty')),
  });
  const result = spawnSync(process.execPath, [setupPath], { env, encoding: 'utf8' });

  if (result.status !== 1) {
    // Diagnose which host the child still finds, from the same environment.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { discoverPowerShellHosts } from ${JSON.stringify(powershellHostPath)};
      const env = process.env;
      const result = discoverPowerShellHosts({ platform: 'win32', env, pathValue: env.PATH ?? '' });
      console.log(JSON.stringify({ PATH: env.PATH, Path: env.Path, ProgramFiles: env.ProgramFiles, SystemRoot: env.SystemRoot, hosts: result.hosts }, null, 1));
    `], { env, encoding: 'utf8' });
    assert.fail(`expected exit 1\n${result.stdout}${result.stderr}\n--- probe ---\n${probe.stdout}${probe.stderr}`);
  }
  assert.match(result.stderr, /pwsh\.exe/);
});

test('setup aborts the whole install when one host query fails', { skip: windowsFakeHostsSkip }, (t) => {
  const directories = makeDirectories(t);
  const hosts = join(directories.directory, 'hosts');
  mkdirSync(hosts, { recursive: true });
  const good = join(hosts, 'powershell.exe');
  writeFileSync(good, `#!/bin/sh\nprintf '%s\\n' '${join(directories.directory, 'ps51', 'profile.ps1')}'\n`);
  chmodSync(good, 0o755);
  const bad = join(hosts, 'pwsh.exe');
  writeFileSync(bad, '#!/bin/sh\nexit 3\n');
  chmodSync(bad, 0o755);

  const result = spawnSync(process.execPath, [setupPath], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/bin/bash',
      USERPROFILE: directories.homeDir,
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
      ...pathOverride(hosts),
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(existsSync(join(directories.directory, 'ps51', 'profile.ps1')), false);
});

test('setup --dry-run --shell powershell prints only the function', { skip: windowsFakeHostsSkip }, (t) => {
  const directories = makeDirectories(t);
  const hosts = join(directories.directory, 'hosts');
  mkdirSync(hosts, { recursive: true });
  const host = join(hosts, 'pwsh.exe');
  writeFileSync(host, `#!/bin/sh\nprintf '%s\\n' '${join(directories.directory, 'ps7', 'profile.ps1')}'\n`);
  chmodSync(host, 0o755);

  const result = spawnSync(process.execPath, [setupPath, '--dry-run', '--shell', 'powershell'], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/bin/bash',
      USERPROFILE: directories.homeDir,
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
      ...pathOverride(hosts),
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, renderFunctionSource('powershell', repoRoot));
  assert.equal(existsSync(join(directories.directory, 'ps7', 'profile.ps1')), false);
  assert.match(result.stderr, /Would write/);
});

test('setup --dry-run --shell powershell fails when no host is found', (t) => {
  const directories = makeDirectories(t);
  const result = spawnSync(process.execPath, [setupPath, '--dry-run', '--shell', 'powershell'], {
    env: envWith(process.env, {
      PI_PRESETS_PLATFORM: 'win32',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/bin/bash',
      USERPROFILE: directories.homeDir,
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
      ...pathOverride(join(directories.directory, 'empty')),
    }),
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No PowerShell host found/);
  assert.match(result.stderr, /pwsh\.exe/);
});

test('setup --dry-run --shell powershell fails when a host query fails', { skip: windowsFakeHostsSkip }, (t) => {
  const directories = makeDirectories(t);
  const hosts = join(directories.directory, 'hosts');
  mkdirSync(hosts, { recursive: true });
  const good = join(hosts, 'powershell.exe');
  writeFileSync(good, `#!/bin/sh\nprintf '%s\\n' '${join(directories.directory, 'ps51', 'profile.ps1')}'\n`);
  chmodSync(good, 0o755);
  const bad = join(hosts, 'pwsh.exe');
  writeFileSync(bad, '#!/bin/sh\nexit 3\n');
  chmodSync(bad, 0o755);

  const result = spawnSync(process.execPath, [setupPath, '--dry-run', '--shell', 'powershell'], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/bin/bash',
      USERPROFILE: directories.homeDir,
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
      ...pathOverride(hosts),
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Could not query every PowerShell host/);
});

test('setup escapes single quotes in the reload hint', { skip: windowsFakeHostsSkip }, (t) => {
  const directories = makeDirectories(t);
  const hosts = join(directories.directory, 'hosts');
  mkdirSync(hosts, { recursive: true });
  const profile = join(directories.directory, "ps7's dir", 'Microsoft.PowerShell_profile.ps1');
  const host = join(hosts, 'pwsh.exe');
  writeFileSync(host, `#!/bin/sh\nprintf '%s\\n' "${profile}"\n`);
  chmodSync(host, 0o755);

  const result = spawnSync(process.execPath, [setupPath], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/bin/bash',
      USERPROFILE: directories.homeDir,
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
      ...pathOverride(hosts),
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes(`. '${join(directories.directory, "ps7''s dir", 'Microsoft.PowerShell_profile.ps1')}'`),
    result.stdout,
  );
});

test('teardown strips the profile a PowerShell host reports', { skip: windowsFakeHostsSkip }, (t) => {
  const directories = makeDirectories(t);
  const hosts = join(directories.directory, 'hosts');
  mkdirSync(hosts, { recursive: true });
  const host = join(hosts, 'pwsh.exe');
  const profile = join(directories.directory, 'ps7', 'Microsoft.PowerShell_profile.ps1');
  writeFileSync(host, `#!/bin/sh\nprintf '%s\\n' '${profile}'\n`);
  chmodSync(host, 0o755);
  mkdirSync(dirname(profile), { recursive: true });
  writeFileSync(profile, '# >>> pi-presets >>>\nfunction pi { }\n# <<< pi-presets <<<\n');

  const result = spawnSync(process.execPath, [teardownPath], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/bin/bash',
      USERPROFILE: directories.homeDir,
      // Pinned: an inherited OneDrive would point the candidate scan at the
      // developer's real OneDrive\Documents\PowerShell profile.
      OneDrive: join(directories.directory, 'OneDrive'),
      ...pathOverride(hosts),
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(profile, 'utf8'), '');
  assert.match(result.stdout, /Stripped the managed block from/);
  assert.doesNotMatch(result.stderr, /looking at the default profile paths instead/);
});

test('teardown still strips the computed candidates when a host is broken', { skip: windowsFakeHostsSkip }, (t) => {
  const directories = makeDirectories(t);
  const hosts = join(directories.directory, 'hosts');
  mkdirSync(hosts, { recursive: true });
  const broken = join(hosts, 'pwsh.exe');
  writeFileSync(broken, '#!/bin/sh\nexit 3\n');
  chmodSync(broken, 0o755);
  // The computed candidate is the only profile that can be found once the
  // host itself cannot answer, so it is what the degraded run must strip.
  const profile = join(directories.homeDir, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
  mkdirSync(dirname(profile), { recursive: true });
  writeFileSync(profile, '# >>> pi-presets >>>\nfunction pi { }\n# <<< pi-presets <<<\n');
  // The OneDrive candidate is computed too, so it is covered here as well; the
  // environment is pinned so it cannot resolve to the developer's real one.
  const oneDriveProfile = join(
    directories.directory, 'OneDrive', 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1',
  );
  mkdirSync(dirname(oneDriveProfile), { recursive: true });
  writeFileSync(oneDriveProfile, '# >>> pi-presets >>>\nfunction pi { }\n# <<< pi-presets <<<\n');

  const result = spawnSync(process.execPath, [teardownPath], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      SHELL: '/bin/bash',
      USERPROFILE: directories.homeDir,
      OneDrive: join(directories.directory, 'OneDrive'),
      ...pathOverride(hosts),
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(profile, 'utf8'), '');
  assert.equal(readFileSync(oneDriveProfile, 'utf8'), '');
  assert.match(result.stdout, /Stripped the managed block from/);
  assert.match(result.stderr, /pwsh\.exe: exited with exit code 3/);
  assert.match(result.stderr, /looking at the default profile paths instead/);
});

test('setup and teardown keep the POSIX usage wording verbatim', (t) => {
  const directories = makeDirectories(t);
  const env = {
    ...process.env,
    PI_PRESETS_PLATFORM: 'linux',
    HOME: directories.homeDir,
    XDG_CONFIG_HOME: directories.configHome,
    SHELL: '/usr/bin/nu',
  };

  const setupMissing = spawnSync(process.execPath, [setupPath, '--shell'], { env, encoding: 'utf8' });
  const setupUnsupported = spawnSync(process.execPath, [setupPath], { env, encoding: 'utf8' });
  const teardownMissing = spawnSync(process.execPath, [teardownPath, '--shell'], { env, encoding: 'utf8' });
  const teardownUnsupported = spawnSync(
    process.execPath,
    [teardownPath, '--shell', 'nu'],
    { env, encoding: 'utf8' },
  );

  assert.equal(setupMissing.status, 2);
  assert.equal(
    setupMissing.stderr.trim(),
    'pi-presets setup: --shell requires fish, bash, or zsh.',
  );
  assert.equal(setupUnsupported.status, 2);
  assert.equal(
    setupUnsupported.stderr.trim(),
    'pi-presets setup: Unsupported shell: nu. Choose fish, bash, or zsh.',
  );
  assert.equal(teardownMissing.status, 2);
  assert.equal(
    teardownMissing.stderr.trim(),
    'pi-presets teardown: --shell requires fish, bash, or zsh.',
  );
  assert.equal(teardownUnsupported.status, 2);
  assert.equal(
    teardownUnsupported.stderr.trim(),
    'pi-presets teardown: Unsupported shell: nu. Choose fish, bash, or zsh.',
  );
});
