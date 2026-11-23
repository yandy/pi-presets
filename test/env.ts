import process from 'node:process';

/**
 * Replace the PATH of a spawned child on every platform.
 *
 * Windows keeps the inherited variable spelled `Path`, so an env object built by
 * spreading `process.env` and then adding `PATH` can carry both entries; Windows
 * then resolves the name case-insensitively and may pick the inherited one. Spread
 * this instead of assigning `PATH` directly.
 */
export function pathOverride(value: string): NodeJS.ProcessEnv {
  return process.platform === 'win32'
    ? { PATH: value, Path: value }
    : { PATH: value };
}
