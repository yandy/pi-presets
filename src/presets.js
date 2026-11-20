import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const VALID_NAME = /^[A-Za-z0-9._-]+$/;

export class PresetUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PresetUsageError';
  }
}

function isPreset(root, name) {
  try {
    return statSync(join(root, name)).isDirectory()
      && statSync(join(root, name, 'package.json')).isFile();
  } catch {
    return false;
  }
}

export function listPresets(presetsRoot) {
  return readdirSync(presetsRoot)
    .filter((name) => isPreset(presetsRoot, name))
    .sort();
}

function resolvePreset(presetsRoot, name) {
  if (!isPreset(presetsRoot, name)) {
    const available = listPresets(presetsRoot);
    const suffix = available.length > 0
      ? ` Available presets: ${available.join(', ')}.`
      : ' No presets are available.';
    throw new PresetUsageError(`Unknown preset: ${name}.${suffix}`);
  }
  return join(presetsRoot, name);
}

function parsePresetNames(value) {
  const names = value.split(',').map((name) => name.trim());
  for (const name of names) {
    if (!VALID_NAME.test(name) || name === '.' || name === '..') {
      throw new PresetUsageError(`Invalid preset name in: ${JSON.stringify(value)}`);
    }
  }
  return names;
}

export function expandPresetArgs(args, presetsRoot) {
  const expanded = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      expanded.push(...args.slice(index));
      break;
    }

    let value;
    if (argument === '-ps' || argument === '--preset') {
      if (index + 1 >= args.length) {
        throw new PresetUsageError(`${argument} requires a preset name.`);
      }
      value = args[index + 1];
      index += 1;
    } else if (argument.startsWith('--preset=')) {
      value = argument.slice('--preset='.length);
    } else {
      expanded.push(argument);
      continue;
    }

    for (const name of parsePresetNames(value)) {
      expanded.push('-e', resolvePreset(presetsRoot, name));
    }
  }

  return expanded;
}
