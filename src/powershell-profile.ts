import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  END_MARKER,
  START_MARKER,
  locateManagedBlock,
  renderPowerShellFunction,
  stripManagedBlock,
  updateRc,
} from './shell-integration.ts';

// PowerShell profiles are saved by the host as UTF-16 unless told otherwise;
// decoding those as UTF-8 would corrupt every non-ASCII byte in the user's
// profile, so setup refuses and asks for a conversion instead.
export class ProfileEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileEncodingError';
  }
}

export type ProfileContents =
  | { kind: 'missing' }
  | { kind: 'utf8'; text: string }
  | { kind: 'utf8-bom'; text: string };

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const PROFILE_FILE_NAME = 'Microsoft.PowerShell_profile.ps1';

function isUtf16Bom(buffer: Buffer): boolean {
  const [first, second] = buffer;
  return (first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff);
}

export function readProfileFile(path: string): ProfileContents {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }

  if (isUtf16Bom(buffer)) {
    throw new ProfileEncodingError(
      `${path}: this profile is a UTF-16 encoded file; save it as UTF-8 before running setup or teardown.`,
    );
  }

  if (buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    return { kind: 'utf8-bom', text: buffer.subarray(UTF8_BOM.length).toString('utf8') };
  }

  return { kind: 'utf8', text: buffer.toString('utf8') };
}

export function renderPowerShellBlock(repoRoot: string): string {
  const body = renderPowerShellFunction(repoRoot).replaceAll('\n', '\r\n');
  return `${START_MARKER}\r\n${body}${END_MARKER}`;
}

interface ProfilePlan {
  path: string;
  contents: ProfileContents;
  text: string;
}

// Windows PowerShell 5.1 decodes a BOM-less profile as ANSI, which would mangle
// a non-ASCII repo path inside the generated function.
const NON_ASCII = /[^\x00-\x7F]/;

function bomFor(contents: ProfileContents, addBomToBomlessProfile: boolean): string {
  // New profiles always get a BOM: 5.1 needs it for anything non-ASCII.
  if (contents.kind === 'missing') return '\uFEFF';
  if (contents.kind === 'utf8-bom') return '\uFEFF';
  return addBomToBomlessProfile ? '\uFEFF' : '';
}

function writePlan(plan: ProfilePlan, addBomToBomlessProfile: boolean): void {
  mkdirSync(dirname(plan.path), { recursive: true });
  const bom = bomFor(plan.contents, addBomToBomlessProfile);
  writeFileSync(plan.path, `${bom}${plan.text}`, 'utf8');
}

export interface InstallPowerShellProfilesOptions {
  profilePaths: readonly string[];
  repoRoot: string;
}

export interface RemovePowerShellProfilesOptions {
  profilePaths: readonly string[];
}

// Every profile is read, decoded and checked before the first write, so one
// UTF-16 file or broken managed block aborts the whole run untouched.
export function installPowerShellProfiles({
  profilePaths,
  repoRoot,
}: InstallPowerShellProfilesOptions): string[] {
  const block = renderPowerShellBlock(repoRoot);
  const plans = profilePaths.map((path): ProfilePlan => {
    const contents = readProfileFile(path);
    const original = contents.kind === 'missing' ? '' : contents.text;
    return { path, contents, text: updateRc(original, block, path, '\r\n') };
  });

  // A BOM-less profile only gets one when the function itself needs it, so
  // ASCII-only installs keep their byte-for-byte teardown.
  const addBomToBomlessProfile = NON_ASCII.test(renderPowerShellFunction(repoRoot));
  for (const plan of plans) writePlan(plan, addBomToBomlessProfile);
  return plans.map((plan) => plan.path);
}

export function removePowerShellProfiles({
  profilePaths,
}: RemovePowerShellProfilesOptions): string[] {
  const plans: ProfilePlan[] = [];
  for (const path of profilePaths) {
    const contents = readProfileFile(path);
    if (contents.kind === 'missing') continue;
    if (locateManagedBlock(contents.text, path) === undefined) continue;
    plans.push({ path, contents, text: stripManagedBlock(contents.text, path) });
  }

  for (const plan of plans) writePlan(plan, false);
  return plans.map((plan) => plan.path);
}

export interface PowerShellProfileCandidatesOptions {
  env: NodeJS.ProcessEnv;
}

// Host `join` on purpose: production runs on win32, where it is `win32.join`,
// while the tests need paths this platform can actually create.
export function powerShellProfileCandidates({
  env,
}: PowerShellProfileCandidatesOptions): string[] {
  const userProfile = env.USERPROFILE;
  if (userProfile === undefined || userProfile === '') return [];

  const roots = [userProfile];
  const oneDrive = env.OneDrive;
  if (oneDrive !== undefined && oneDrive !== '') roots.push(oneDrive);

  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(join(root, 'Documents', 'PowerShell', PROFILE_FILE_NAME));
    candidates.push(join(root, 'Documents', 'WindowsPowerShell', PROFILE_FILE_NAME));
  }
  return candidates;
}
