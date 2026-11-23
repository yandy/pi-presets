#!/usr/bin/env node

import { homedir } from 'node:os';
import { join } from 'node:path';

import { currentPlatform } from './platform.ts';
import { discoverPowerShellHosts } from './powershell-host.ts';
import { powerShellProfileCandidates, removePowerShellProfiles } from './powershell-profile.ts';
import {
  isSupportedShell,
  removeShellIntegration,
  supportedShells,
  type PosixShell,
  type SupportedShell,
} from './shell-integration.ts';

class TeardownUsageError extends Error {}

interface TeardownOptions {
  shells: readonly SupportedShell[];
  dryRun: boolean;
}

function unsupportedShellMessage(shell: string, platform: NodeJS.Platform): string {
  const label = shell || '(not set)';
  const choices = supportedShells(platform).join(', ');
  if (platform === 'win32') {
    return `Unsupported shell: ${label}. On Windows, choose ${choices}.`;
  }
  if (shell === 'powershell') {
    return `Unsupported shell: ${label}. PowerShell is not supported on this platform. `
      + `Choose ${choices}.`;
  }
  return `Unsupported shell: ${label}. Choose ${choices}.`;
}

function parseTeardownArgs(
  args: readonly string[],
  platform: NodeJS.Platform,
): TeardownOptions {
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
      throw new TeardownUsageError(`--shell requires ${supportedShells(platform).join(', ')}.`);
    }
    selected = args[index + 1];
    index += 1;
  }

  if (selected === undefined) {
    return { shells: supportedShells(platform), dryRun };
  }
  if (!isSupportedShell(selected, platform)) {
    throw new TeardownUsageError(unsupportedShellMessage(selected, platform));
  }
  return { shells: [selected], dryRun };
}

try {
  const platform = currentPlatform(process.env);
  const { shells, dryRun } = parseTeardownArgs(process.argv.slice(2), platform);
  const homeDir = process.env.HOME || homedir();
  const configHome = process.env.XDG_CONFIG_HOME || join(homeDir, '.config');
  const posixShells = shells.filter((shell): shell is PosixShell => shell !== 'powershell');
  const { files, rcFiles, keptFiles } = removeShellIntegration({
    shells: posixShells,
    homeDir,
    configHome,
    dryRun,
  });

  const lines: string[] = [];
  for (const file of files) {
    lines.push(`${dryRun ? 'Would remove' : 'Removed'}: ${file}`);
  }
  for (const file of rcFiles) {
    lines.push(
      `${dryRun ? 'Would strip the managed block from' : 'Stripped the managed block from'}: ${file}`,
    );
  }
  for (const file of keptFiles) {
    lines.push(`Kept: ${file} (still sourced by another shell rc)`);
  }

  if (platform === 'win32' && shells.includes('powershell')) {
    const { hosts, failures } = discoverPowerShellHosts({
      platform,
      env: process.env,
      pathValue: process.env.PATH ?? '',
    });
    // A broken host must not block the cleanup: fall back to the computed
    // profile locations instead of leaving the block behind.
    for (const failure of failures) {
      console.error(
        `pi-presets teardown: ${failure.message}; looking at the default profile paths instead.`,
      );
    }

    const candidates = [...new Set([
      ...hosts.map((host) => host.profilePath),
      ...powerShellProfileCandidates({ env: process.env }),
    ])];
    if (dryRun) {
      if (candidates.length > 0) {
        lines.push(
          `Would check these PowerShell profiles for a managed block: ${candidates.join(', ')}`,
        );
      }
    } else {
      for (const file of removePowerShellProfiles({ profilePaths: candidates })) {
        lines.push(`Stripped the managed block from: ${file}`);
      }
    }
  }

  if (lines.length === 0) {
    console.log('Nothing to remove: no pi-presets shell integration found.');
  } else {
    if (dryRun) console.log('Dry run: nothing was written.');
    for (const line of lines) console.log(line);
  }
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`pi-presets teardown: ${message}`);
  process.exitCode = error instanceof TeardownUsageError ? 2 : 1;
}
