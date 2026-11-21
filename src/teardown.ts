#!/usr/bin/env node

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  isSupportedShell,
  removeShellIntegration,
  SUPPORTED_SHELLS,
  type SupportedShell,
} from './shell-integration.ts';

class TeardownUsageError extends Error {}

interface TeardownOptions {
  shells: readonly SupportedShell[];
  dryRun: boolean;
}

function parseTeardownArgs(args: readonly string[]): TeardownOptions {
  let selected: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument !== '--shell') {
      throw new TeardownUsageError(`Unknown teardown option: ${argument}`);
    }
    if (index + 1 >= args.length) {
      throw new TeardownUsageError('--shell requires fish, bash, or zsh.');
    }
    selected = args[index + 1];
    index += 1;
  }

  if (selected === undefined) {
    return { shells: SUPPORTED_SHELLS, dryRun };
  }
  if (!isSupportedShell(selected)) {
    throw new TeardownUsageError(
      `Unsupported shell: ${selected || '(not set)'}. Choose fish, bash, or zsh.`,
    );
  }
  return { shells: [selected], dryRun };
}

try {
  const { shells, dryRun } = parseTeardownArgs(process.argv.slice(2));
  const homeDir = process.env.HOME || homedir();
  const configHome = process.env.XDG_CONFIG_HOME || join(homeDir, '.config');
  const { files, rcFiles, keptFiles } = removeShellIntegration({
    shells,
    homeDir,
    configHome,
    dryRun,
  });

  if (files.length === 0 && rcFiles.length === 0 && keptFiles.length === 0) {
    console.log('Nothing to remove: no pi-presets shell integration found.');
  } else {
    if (dryRun) console.log('Dry run: nothing was written.');
    for (const file of files) {
      console.log(`${dryRun ? 'Would remove' : 'Removed'}: ${file}`);
    }
    for (const file of rcFiles) {
      console.log(
        `${dryRun ? 'Would strip the managed block from' : 'Stripped the managed block from'}: ${file}`,
      );
    }
    for (const file of keptFiles) {
      console.log(`Kept: ${file} (still sourced by another shell rc)`);
    }
  }
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`pi-presets teardown: ${message}`);
  process.exitCode = error instanceof TeardownUsageError ? 2 : 1;
}
