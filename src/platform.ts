// Windows-only behaviour cannot be exercised on a POSIX runner, so the CLI
// reads the platform through this seam (PI_PRESETS_PLATFORM) instead of using
// process.platform directly.
export function currentPlatform(env: NodeJS.ProcessEnv = process.env): NodeJS.Platform {
  const override = env.PI_PRESETS_PLATFORM;
  return (override || process.platform) as NodeJS.Platform;
}
