#!/usr/bin/env node

import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installShellIntegration,
  isSupportedShell,
  renderFunctionSource,
  shellIntegrationPaths,
  type SupportedShell,
} from './shell-integration.ts';

class SetupUsageError extends Error {}

interface SetupOptions {
  shell: SupportedShell;
  dryRun: boolean;
}

function parseSetupArgs(args: readonly string[]): SetupOptions {
  let selected: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument !== '--shell') {
      throw new SetupUsageError(`Unknown setup option: ${argument}`);
    }
    if (index + 1 >= args.length) {
      throw new SetupUsageError('--shell requires fish, bash, or zsh.');
    }
    selected = args[index + 1];
    index += 1;
  }

  const shell = selected ?? basename(process.env.SHELL ?? '');
  if (!isSupportedShell(shell)) {
    throw new SetupUsageError(
      `Unsupported shell: ${shell || '(not set)'}. Choose fish, bash, or zsh.`,
    );
  }
  return { shell, dryRun };
}

try {
  const { shell, dryRun } = parseSetupArgs(process.argv.slice(2));
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const homeDir = process.env.HOME || homedir();
  const configHome = process.env.XDG_CONFIG_HOME || join(homeDir, '.config');

  if (dryRun) {
    process.stdout.write(renderFunctionSource(shell, repoRoot));
    console.error(`Dry run: no files written for ${shell}.`);
    console.error(
      `Would write: ${shellIntegrationPaths(shell, homeDir, configHome).join(', ')}`,
    );
    if (process.stdout.isTTY) {
      const command = shell === 'fish'
        ? 'eval (npm run --silent setup -- --dry-run --shell fish | string collect)'
        : `eval "$(npm run --silent setup -- --dry-run --shell ${shell})"`;
      console.error(`Apply it to the current ${shell} shell with: ${command}`);
    }
  } else {
    const { files } = installShellIntegration({ shell, repoRoot, homeDir, configHome });

    console.log(`Installed pi-presets integration for ${shell}:`);
    for (const file of files) console.log(`  ${file}`);

    const currentShell = basename(process.env.SHELL ?? '');
    if (shell === currentShell) {
      console.log('Reload your shell with: exec "$SHELL"');
    } else if (shell === 'fish') {
      console.log(`Start fish, or source this file from fish: ${files[0]}`);
    } else {
      console.log(`Restart ${shell} or run: source ${files[1]}`);
    }
  }
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`pi-presets setup: ${message}`);
  process.exitCode = error instanceof SetupUsageError ? 2 : 1;
}
