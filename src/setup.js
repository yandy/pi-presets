#!/usr/bin/env node

import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installShellIntegration,
  SUPPORTED_SHELLS,
} from './shell-integration.js';

class SetupUsageError extends Error {}

function parseShell(args) {
  let selected;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
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
  if (!SUPPORTED_SHELLS.includes(shell)) {
    throw new SetupUsageError(
      `Unsupported shell: ${shell || '(not set)'}. Choose fish, bash, or zsh.`,
    );
  }
  return shell;
}

try {
  const shell = parseShell(process.argv.slice(2));
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const homeDir = process.env.HOME || homedir();
  const configHome = process.env.XDG_CONFIG_HOME || join(homeDir, '.config');
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
} catch (error) {
  console.error(`pi-presets setup: ${error.message}`);
  process.exitCode = error instanceof SetupUsageError ? 2 : 1;
}
