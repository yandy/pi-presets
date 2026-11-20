#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  statSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandPresetArgs, PresetUsageError } from './presets.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function findRealPi(pathValue = '') {
  for (const directory of pathValue.split(delimiter)) {
    const candidate = resolve(directory || '.', 'pi');
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error('Could not find an executable pi in PATH.');
}

function runPi(realPi, args) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(realPi, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });
    const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = new Map();

    for (const signal of forwardedSignals) {
      const handler = () => child.kill(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }

    function cleanup() {
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
        resolveExit(128 + (osConstants.signals[signal] ?? 0));
      }
    });
  });
}

try {
  const args = expandPresetArgs(process.argv.slice(2), repoRoot);
  const realPi = findRealPi(process.env.PATH);
  process.exitCode = await runPi(realPi, args);
} catch (error) {
  console.error(`pi-presets: ${error.message}`);
  process.exitCode = error instanceof PresetUsageError ? 2 : 1;
}
