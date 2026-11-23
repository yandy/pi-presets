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

const setupPath = fileURLToPath(new URL('../src/setup.ts', import.meta.url));
const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const teardownPath = fileURLToPath(new URL('../src/teardown.ts', import.meta.url));

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
  const shellPath = shellLookup.stdout.trim();
  test(`generated ${shell} function works from a path with shell metacharacters`, {
    skip: shellLookup.status !== 0,
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
        HOME: directories.homeDir,
        XDG_CONFIG_HOME: directories.configHome,
        SHELL: shellPath,
        PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
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
    env: { ...process.env, HOME: directories.homeDir, XDG_CONFIG_HOME: directories.configHome, SHELL: '/bin/fish' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, renderFunctionSource('bash', repoRoot));
  assert.ok(!existsSync(join(directories.homeDir, '.bashrc')));
  assert.ok(!existsSync(join(directories.configHome, 'pi-presets')));
  assert.match(result.stderr, /dry run/i);
});

const bashLookup = spawnSync('sh', ['-c', 'command -v "$1"', 'shell-lookup', 'bash'], { encoding: 'utf8' });
const bashPath = bashLookup.stdout.trim();

test('setup --dry-run output evaluates into a working function', {
  skip: bashLookup.status !== 0,
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
    { env: { ...process.env, HOME: directories.homeDir, XDG_CONFIG_HOME: directories.configHome }, encoding: 'utf8' },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);

  const result = spawnSync(bashPath, ['-c', 'eval "$1"; pi -ps coding -p hello', 'pi-presets-test', dryRun.stdout], {
    cwd,
    env: {
      ...process.env,
      HOME: directories.homeDir,
      PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
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
    env: { ...process.env, HOME: directories.homeDir, XDG_CONFIG_HOME: directories.configHome, SHELL: '/bin/fish' },
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
const fishPath = fishLookup.stdout.trim();

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
      HOME: directories.homeDir,
      XDG_CONFIG_HOME: directories.configHome,
      PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
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
