import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

export type PowerShellHostKind = 'pwsh' | 'windows-powershell';

export interface PowerShellHost {
  kind: PowerShellHostKind;
  executable: string;
  profilePath: string;
}

export interface PowerShellHostFailure {
  kind: PowerShellHostKind;
  executable: string;
  message: string;
}

export interface DiscoverPowerShellHostsOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  pathValue: string;
  query?: (executable: string) => string;
}

// Ask the host for its own profile path so we never guess at a user's
// Documents folder (OneDrive redirection, localized names, ...).
export const PROFILE_QUERY_COMMAND =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Write-Output $PROFILE';

const QUERY_TIMEOUT_MS = 10_000;
const STDERR_EXCERPT_LENGTH = 200;

interface HostCandidate {
  kind: PowerShellHostKind;
  executable: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// `platform` is win32 here, so the separator must be ';' even when this module
// runs on a POSIX system (tests, CI) where `delimiter` is ':'.
function findOnPath(pathValue: string, name: string): string | undefined {
  for (const directory of pathValue.split(';')) {
    if (directory === '') continue;
    const candidate = join(directory, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function profileQueryError(executable: string, reason: string): Error {
  return new Error(`${executable}: ${reason}`);
}

function queryProfile(executable: string): string {
  const result = spawnSync(
    executable,
    ['-NoProfile', '-NonInteractive', '-Command', PROFILE_QUERY_COMMAND],
    { encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, windowsHide: true },
  );

  if (result.error) {
    throw profileQueryError(executable, `could not run ${PROFILE_QUERY_COMMAND}: ${result.error.message}`);
  }

  const stderr = (result.stderr ?? '').trim().slice(0, STDERR_EXCERPT_LENGTH);
  if (result.status !== 0) {
    const status = result.status === null ? `signal ${result.signal}` : `exit code ${result.status}`;
    const detail = stderr === '' ? '' : `: ${stderr}`;
    throw profileQueryError(executable, `exited with ${status}${detail}`);
  }

  return result.stdout ?? '';
}

function hostCandidates(options: DiscoverPowerShellHostsOptions): HostCandidate[] {
  const { env, pathValue } = options;
  // Known install locations are only trusted when the environment names them.
  const programFiles = env.ProgramFiles;
  const systemRoot = env.SystemRoot;
  const pwshFallback = programFiles
    ? join(programFiles, 'PowerShell', '7', 'pwsh.exe')
    : undefined;
  const windowsPowerShellFallback = systemRoot
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : undefined;

  const pwsh = findOnPath(pathValue, 'pwsh.exe')
    ?? (pwshFallback !== undefined && isFile(pwshFallback) ? pwshFallback : undefined);
  const windowsPowerShell = findOnPath(pathValue, 'powershell.exe')
    ?? (windowsPowerShellFallback !== undefined && isFile(windowsPowerShellFallback)
      ? windowsPowerShellFallback
      : undefined);

  // pwsh (PowerShell 7+) first: it is the host we prefer to write for.
  const candidates: HostCandidate[] = [];
  if (pwsh !== undefined) candidates.push({ kind: 'pwsh', executable: pwsh });
  if (windowsPowerShell !== undefined) {
    candidates.push({ kind: 'windows-powershell', executable: windowsPowerShell });
  }
  return candidates;
}

export function discoverPowerShellHosts(
  options: DiscoverPowerShellHostsOptions,
): { hosts: PowerShellHost[]; failures: PowerShellHostFailure[] } {
  if (options.platform !== 'win32') {
    return { hosts: [], failures: [] };
  }

  const query = options.query ?? queryProfile;
  const hosts: PowerShellHost[] = [];
  const failures: PowerShellHostFailure[] = [];

  for (const candidate of hostCandidates(options)) {
    let profilePath: string;
    try {
      profilePath = query(candidate.executable).trim();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ ...candidate, message });
      continue;
    }

    if (profilePath === '') {
      failures.push({
        ...candidate,
        message: `${candidate.executable}: $PROFILE returned nothing`,
      });
      continue;
    }

    hosts.push({ ...candidate, profilePath });
  }

  return { hosts, failures };
}
