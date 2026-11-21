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
