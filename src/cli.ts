#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';

import { expandPresetArgs, PresetUsageError } from './presets.ts';
import { resolveRealPi, spawnSpec, type RealPiCommand } from './windows-command.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function runPi(realPi: RealPiCommand, args: readonly string[]): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const spec = spawnSpec(realPi, args);
    const child = spawn(spec.file, spec.args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: 'inherit',
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    const handledSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const handlers = new Map<NodeJS.Signals, () => void>();

    for (const signal of handledSignals) {
      // Foreground Ctrl-C already reaches both processes. Wait for the child
      // instead of delivering a second SIGINT; other signals need forwarding.
      const handler: () => void = signal === 'SIGINT'
        ? () => {}
        : () => { child.kill(signal); };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }

    function cleanup(): void {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    }

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code !== null) {
        resolveExit(code);
      } else {
        const signalNumber = signal ? osConstants.signals[signal] : 0;
        resolveExit(128 + signalNumber);
      }
    });
  });
}

try {
  const args = expandPresetArgs(process.argv.slice(2), repoRoot);
  const realPi = resolveRealPi({
    pathValue: process.env.PATH ?? '',
    platform: process.platform,
    pathExt: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
  });
  process.exitCode = await runPi(realPi, args);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`pi-presets: ${message}`);
  process.exitCode = error instanceof PresetUsageError ? 2 : 1;
}
