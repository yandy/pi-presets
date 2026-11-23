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

/**
 * Build a child environment from `process.env` with case-insensitive overrides.
 *
 * Windows environment blocks can carry a key in a different casing than the one
 * written here (`SYSTEMROOT` vs `SystemRoot`). Spreading both leaves duplicate
 * entries, and Windows resolves the name case-insensitively — possibly picking
 * the inherited one and defeating the override. Drop every casing variant first.
 */
export function envWith(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const replaced = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (replaced.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return Object.assign(result, overrides);
}
