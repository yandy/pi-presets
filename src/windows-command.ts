import {
  accessSync,
  constants as fsConstants,
  statSync,
} from 'node:fs';
import { delimiter, resolve } from 'node:path';

// npm and managed installs on Windows ship a POSIX `pi` script next to
// `pi.cmd`/`pi.ps1`; the extensionless file only runs under sh, so it is never
// a usable target there. Discovery therefore follows PATHEXT instead.
export interface RealPiCommand {
  path: string;
  kind: 'direct' | 'cmd';
}

export interface ResolveRealPiOptions {
  pathValue: string;
  platform: NodeJS.Platform;
  pathExt: string;
}

// Return value of spawnSpec(); not part of the public interface list.
type SpawnSpec = {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
};

const CMD_METACHARACTER = /[&|<>^()]/;
const CMD_METACHARACTERS = /[&|<>^()]/g;
const WHITESPACE = /\s/;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolvePosixRealPi(pathValue: string): RealPiCommand {
  for (const directory of pathValue.split(delimiter)) {
    const candidate = resolve(directory || '.', 'pi');
    if (!isFile(candidate)) continue;
    try {
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      // Try the next PATH entry.
      continue;
    }
    return { path: candidate, kind: 'direct' };
  }
  throw new Error('Could not find an executable pi in PATH.');
}

function resolveWindowsRealPi(pathValue: string, pathExt: string): RealPiCommand {
  const extensions = pathExt
    .split(';')
    .filter((extension) => extension !== '')
    .map((extension) => extension.toLowerCase());

  for (const directory of pathValue.split(';')) {
    for (const extension of extensions) {
      const candidate = resolve(directory || '.', `pi${extension}`);
      if (!isFile(candidate)) continue;
      const kind = extension === '.exe' || extension === '.com' ? 'direct' : 'cmd';
      return { path: candidate, kind };
    }
  }

  const searched = extensions.map((extension) => `pi${extension}`).join(', ');
  throw new Error(`pi is not on PATH (looked for ${searched})`);
}

export function resolveRealPi(options: ResolveRealPiOptions): RealPiCommand {
  return options.platform === 'win32'
    ? resolveWindowsRealPi(options.pathValue, options.pathExt)
    : resolvePosixRealPi(options.pathValue);
}

// MSVCRT argument parsing: backslashes are literal unless they precede a
// double quote, where each one is doubled, and the quote itself is escaped.
function escapeQuotedArgument(argument: string): string {
  let escaped = '';
  let backslashes = 0;

  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      escaped += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    escaped += `${'\\'.repeat(backslashes)}${character}`;
    backslashes = 0;
  }

  // Trailing backslashes would escape the closing quote.
  return escaped + '\\'.repeat(backslashes * 2);
}

export function quoteForCmd(argument: string): string {
  if (argument === '') return '""';
  if (argument.includes('"') || WHITESPACE.test(argument)) {
    // Inside double quotes cmd.exe stops treating metacharacters specially.
    return `"${escapeQuotedArgument(argument)}"`;
  }
  if (CMD_METACHARACTER.test(argument)) {
    return argument.replace(CMD_METACHARACTERS, (character) => `^${character}`);
  }
  return argument;
}

// `cmd.exe /s /c` strips the outer quotes, so the whole command line is wrapped
// in a second pair and the executable keeps its own.
export function buildCmdCommandLine(command: RealPiCommand, args: readonly string[]): string {
  return `""${command.path}" ${args.map(quoteForCmd).join(' ')}"`;
}

export function spawnSpec(command: RealPiCommand, args: readonly string[]): SpawnSpec {
  if (command.kind === 'cmd') {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', buildCmdCommandLine(command, args)],
      windowsVerbatimArguments: true,
    };
  }
  return {
    file: command.path,
    args: [...args],
    windowsVerbatimArguments: false,
  };
}
