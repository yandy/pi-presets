#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function runProcess(command, args, options) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveProcess();
      } else {
        const result = signal ? `signal ${signal}` : `exit code ${code}`;
        reject(new Error(`${command} ${args.join(' ')} failed with ${result}`));
      }
    });
  });
}

function readManifest(directory, name) {
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`Could not read preset "${name}" package.json: ${error.message}`, {
      cause: error,
    });
  }
}

function hasDependencies(manifest) {
  return ['dependencies', 'devDependencies', 'optionalDependencies']
    .some((field) => Object.keys(manifest[field] ?? {}).length > 0);
}

export async function installPresetDependencies({ repoRoot, runner = runProcess }) {
  const names = readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules' && entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const installed = [];

  for (const name of names) {
    const directory = join(repoRoot, name);
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readManifest(directory, name);
    if (!hasDependencies(manifest)) continue;

    const command = existsSync(join(directory, 'package-lock.json')) ? 'ci' : 'install';
    try {
      await runner('npm', [command], { cwd: directory, stdio: 'inherit' });
    } catch (error) {
      throw new Error(`Dependency installation failed for preset "${name}": ${error.message}`, {
        cause: error,
      });
    }
    installed.push(name);
  }

  return installed;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const repoRoot = fileURLToPath(new URL('../', import.meta.url));
    const installed = await installPresetDependencies({ repoRoot });
    if (installed.length > 0) {
      console.log(`Installed dependencies for presets: ${installed.join(', ')}`);
    }
  } catch (error) {
    console.error(`pi-presets install: ${error.message}`);
    process.exitCode = 1;
  }
}
