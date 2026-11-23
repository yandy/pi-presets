#!/usr/bin/env node

import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentPlatform } from './platform.ts';
import {
  discoverPowerShellHosts,
  type PowerShellHost,
  type PowerShellHostFailure,
} from './powershell-host.ts';
import { installPowerShellProfiles } from './powershell-profile.ts';
import {
  installShellIntegration,
  isSupportedShell,
  renderFunctionSource,
  renderShortcutHint,
  shellIntegrationPaths,
  supportedShells,
  type SupportedShell,
} from './shell-integration.ts';

class SetupUsageError extends Error {}

interface SetupOptions {
  shell: SupportedShell;
  dryRun: boolean;
}

// Windows has one usable host shell, so the default is fixed: no version
// probing, and `--shell` is not needed there.
function defaultShell(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'powershell';
  return basename(process.env.SHELL ?? '');
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

function parseSetupArgs(args: readonly string[], platform: NodeJS.Platform): SetupOptions {
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
      throw new SetupUsageError(`--shell requires ${supportedShells(platform).join(', ')}.`);
    }
    selected = args[index + 1];
    index += 1;
  }

  const shell = selected ?? defaultShell(platform);
  if (!isSupportedShell(shell, platform)) {
    throw new SetupUsageError(unsupportedShellMessage(shell, platform));
  }
  return { shell, dryRun };
}

const POWERSHELL_SEARCH_LOCATIONS =
  'Looked for pwsh.exe and powershell.exe on PATH, %ProgramFiles%\\PowerShell\\7\\pwsh.exe, '
  + 'and %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe.';

const POWERSHELL_INSTALL_HINT = 'Install PowerShell 7 (pwsh.exe) or add it to PATH.';

const NO_POWERSHELL_HOST_MESSAGE =
  `No PowerShell host found; nothing was written. ${POWERSHELL_SEARCH_LOCATIONS} `
  + POWERSHELL_INSTALL_HINT;

const POWERSHELL_DRY_RUN_COMMAND =
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
  + '$OutputEncoding = [Text.Encoding]::UTF8; '
  + 'Invoke-Expression (& npm.cmd run --silent setup -- --dry-run --shell powershell | Out-String)';

interface PowerShellHosts {
  hosts: PowerShellHost[];
  failures: PowerShellHostFailure[];
}

function discoverHosts(platform: NodeJS.Platform): PowerShellHosts {
  return discoverPowerShellHosts({
    platform,
    env: process.env,
    pathValue: process.env.PATH ?? '',
  });
}

function powerShellDryRun(repoRoot: string, platform: NodeJS.Platform): void {
  process.stdout.write(renderFunctionSource('powershell', repoRoot));
  console.error('Dry run: no files written for powershell.');

  const { hosts, failures } = discoverHosts(platform);
  for (const failure of failures) {
    console.error(`Could not query ${failure.message}`);
  }
  if (hosts.length > 0) {
    console.error(`Would write: ${hosts.map((host) => host.profilePath).join(', ')}`);
  } else if (failures.length > 0) {
    console.error('Would write: nothing; every host that was found could not report its profile.');
  } else {
    console.error(
      `Would write: nothing. No PowerShell host found. ${POWERSHELL_SEARCH_LOCATIONS} `
      + POWERSHELL_INSTALL_HINT,
    );
  }
  if (process.stdout.isTTY) {
    console.error(`Apply it to the current powershell session with: ${POWERSHELL_DRY_RUN_COMMAND}`);
  }
}

function installPowerShell(repoRoot: string, platform: NodeJS.Platform): void {
  const { hosts, failures } = discoverHosts(platform);
  // One unreadable host means we do not know its profile path, and writing the
  // rest would leave that host silently unwired: abort before any write.
  if (failures.length > 0) {
    const details = failures.map((failure) => `  ${failure.message}`).join('\n');
    throw new Error(`Could not query every PowerShell host; nothing was written.\n${details}`);
  }
  if (hosts.length === 0) {
    throw new Error(NO_POWERSHELL_HOST_MESSAGE);
  }

  const files = installPowerShellProfiles({
    profilePaths: hosts.map((host) => host.profilePath),
    repoRoot,
  });

  console.log('Installed pi-presets integration for powershell:');
  for (const file of files) console.log(`  ${file}`);
  console.log('');
  for (const host of hosts) {
    console.log(`Restart PowerShell, or run this in it: . '${host.profilePath}'`);
  }

  console.log('');
  for (const line of renderShortcutHint('powershell')) console.log(line);
}

try {
  const platform = currentPlatform(process.env);
  const { shell, dryRun } = parseSetupArgs(process.argv.slice(2), platform);
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));

  if (dryRun) {
    if (shell === 'powershell') {
      powerShellDryRun(repoRoot, platform);
    } else {
      const homeDir = process.env.HOME || homedir();
      const configHome = process.env.XDG_CONFIG_HOME || join(homeDir, '.config');
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
    }
  } else if (shell === 'powershell') {
    installPowerShell(repoRoot, platform);
  } else {
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

    // Printed only on install: --dry-run output is eval'd, so any extra line
    // there would break the function definition.
    console.log('');
    for (const line of renderShortcutHint(shell)) console.log(line);
  }
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`pi-presets setup: ${message}`);
  process.exitCode = error instanceof SetupUsageError ? 2 : 1;
}
