# Windows PowerShell 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在原生 Windows 的 PowerShell 里也能用 `pi -ps coding`：setup 把 `pi` 包装函数写进 PowerShell profile，teardown 干净摘掉，并且包装器能真正启动 Windows 上的 pi。

**Architecture:** 新增三个小模块各自负责一件事——`powershell-host.ts`（找宿主、问 `$PROFILE`）、`powershell-profile.ts`（profile 读写、编码探测、受管块）、`windows-command.ts`（PATHEXT 解析与 cmd 引用）。`shell-integration.ts` 扩成平台感知的 shell 集合与渲染源，`setup.ts`/`teardown.ts`/`cli.ts` 各自接线，全部逻辑通过注入平台与子进程在 Linux 上可测。

**Tech Stack:** TypeScript（Node 22.19+ 直接跑 `.ts`，无构建步骤），`node:test` + `node:assert/strict`，零运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-23-windows-powershell-design.md`

## Global Constraints

- Node.js >= 22.19，仓库零运行时依赖；相对导入必须带 `.ts` 后缀。
- 测试文件 `test/*.test.ts`，`npm test` 跑全部；单文件用 `node --test test/<name>.test.ts`。
- `npm run typecheck` 必须始终通过（`tsc --noEmit`）。
- 现有 POSIX/fish 的可观察行为与测试不得改变。
- 平台门禁：`win32` 只接受 `powershell`；其他平台不接受 `powershell`。测试缝隙是环境变量 `PI_PRESETS_PLATFORM`。
- 单引号字符串，2 空格缩进，语句加分号（与现有代码一致）。
- PowerShell 受管块标记固定为 `# >>> pi-presets >>>` / `# <<< pi-presets <<<`。
- 宿主查询命令固定为 `-NoProfile -NonInteractive -Command '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Write-Output $PROFILE'`，超时 10 秒。
- 退出码沿用：用法错误 2，运行期失败 1。

## Review Focus

- 仓库路径含 `'`（例如 `C:\it's here\pi-presets`）时，PowerShell 单引号字符串必须写成 `''`，否则生成的 `pi` 函数直接语法错误。测试在 Task 2。
- profile 文件末尾没有换行（或只有一个空行）时，`install → remove` 必须逐字节还原；CRLF 文件同样成立。测试在 Task 2。
- `Documents\PowerShell` 目录可能还不存在（装了 pwsh 但从未用过 profile），安装必须创建父目录而不是抛 ENOENT。测试在 Task 2。
- 参数含空格与 `"`（`pi -ps coding -p 'list "ts" files'`）经 `cmd.exe` 转发必须保持原样；`%`/`!` 按文档原样传递不额外处理。测试在 Task 4。
- 一个宿主的 profile 编码/标记不合法时，两个宿主都不能被写入（校验全部通过才落盘）。测试在 Task 2 与 Task 3。

---

### Task 1: 宿主发现

**Files:**
- Create: `src/powershell-host.ts`
- Test: `test/powershell-host.test.ts`

**Interfaces:**
- Consumes: 无（只用 `node:fs`、`node:path`、`node:child_process`）。
- Produces:
  - `type PowerShellHostKind = 'pwsh' | 'windows-powershell'`
  - `interface PowerShellHost { kind: PowerShellHostKind; executable: string; profilePath: string }`
  - `interface PowerShellHostFailure { kind: PowerShellHostKind; executable: string; message: string }`
  - `interface DiscoverPowerShellHostsOptions { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; pathValue: string; query?: (executable: string) => string }`
  - `function discoverPowerShellHosts(options: DiscoverPowerShellHostsOptions): { hosts: PowerShellHost[]; failures: PowerShellHostFailure[] }`
  - `const PROFILE_QUERY_COMMAND: string`

- [ ] **Step 1: 写失败的测试**

`test/powershell-host.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverPowerShellHosts,
  PROFILE_QUERY_COMMAND,
  type DiscoverPowerShellHostsOptions,
} from '../src/powershell-host.ts';

function makeDir(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-presets-host-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// 假宿主：忽略参数，直接打印一个路径，模拟 `$PROFILE`。
function writeFakeHost(directory: string, name: string, profilePath: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${profilePath}'\n`);
  chmodSync(path, 0o755);
  return path;
}

test('returns nothing off Windows', () => {
  const result = discoverPowerShellHosts({
    platform: 'linux',
    env: {},
    pathValue: '/usr/bin',
  });
  assert.deepEqual(result, { hosts: [], failures: [] });
});

test('discovers pwsh on PATH and uses its $PROFILE', (t) => {
  const directory = makeDir(t);
  const profilePath = join(directory, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
  writeFakeHost(directory, 'pwsh.exe', profilePath);

  const result = discoverPowerShellHosts({
    platform: 'win32',
    env: {},
    pathValue: directory,
  });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.hosts, [
    { kind: 'pwsh', executable: join(directory, 'pwsh.exe'), profilePath },
  ]);
});

test('discovers both hosts, pwsh first', (t) => {
  const directory = makeDir(t);
  writeFakeHost(directory, 'pwsh.exe', 'C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1');
  writeFakeHost(directory, 'powershell.exe', 'C:\\Users\\me\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1');

  const result = discoverPowerShellHosts({ platform: 'win32', env: {}, pathValue: directory });

  assert.deepEqual(result.hosts.map((host) => host.kind), ['pwsh', 'windows-powershell']);
});

test('falls back to the known install locations', (t) => {
  const directory = makeDir(t);
  const programFiles = join(directory, 'Program Files');
  const systemRoot = join(directory, 'Windows');
  const pwsh = join(programFiles, 'PowerShell', '7');
  const winPs = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  mkdirSync(pwsh, { recursive: true });
  mkdirSync(winPs, { recursive: true });
  writeFakeHost(pwsh, 'pwsh.exe', 'C:\\pwsh-profile.ps1');
  writeFakeHost(winPs, 'powershell.exe', 'C:\\winps-profile.ps1');

  const result = discoverPowerShellHosts({
    platform: 'win32',
    env: { ProgramFiles: programFiles, SystemRoot: systemRoot },
    pathValue: join(directory, 'empty'),
  });

  assert.deepEqual(result.hosts.map((host) => host.profilePath), [
    'C:\\pwsh-profile.ps1',
    'C:\\winps-profile.ps1',
  ]);
});

test('records a failure and keeps the host that answered', (t) => {
  const directory = makeDir(t);
  writeFakeHost(directory, 'pwsh.exe', 'ignored');
  writeFakeHost(directory, 'powershell.exe', 'ignored');

  const query = (executable: string): string => {
    if (executable.endsWith('pwsh.exe')) throw new Error('timed out');
    return 'C:\\Users\\me\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1';
  };

  const result = discoverPowerShellHosts({ platform: 'win32', env: {}, pathValue: directory, query });

  assert.deepEqual(result.hosts.map((host) => host.kind), ['windows-powershell']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].kind, 'pwsh');
  assert.match(result.failures[0].message, /timed out/);
});

test('treats empty $PROFILE output as a failure', (t) => {
  const directory = makeDir(t);
  writeFakeHost(directory, 'pwsh.exe', 'ignored');

  const result = discoverPowerShellHosts({
    platform: 'win32',
    env: {},
    pathValue: directory,
    query: () => '   \r\n',
  });

  assert.deepEqual(result.hosts, []);
  assert.match(result.failures[0].message, /\$PROFILE/i);
});

test('calls the injected query with the resolved executable', (t) => {
  const directory = makeDir(t);
  const executable = writeFakeHost(directory, 'pwsh.exe', 'C:\\profile.ps1');
  const seen: string[] = [];

  const options: DiscoverPowerShellHostsOptions = {
    platform: 'win32',
    env: {},
    pathValue: directory,
    query: (path) => {
      seen.push(path);
      return 'C:\\profile.ps1';
    },
  };
  discoverPowerShellHosts(options);

  assert.deepEqual(seen, [executable]);
  assert.match(PROFILE_QUERY_COMMAND, /^\s*\[Console\]::OutputEncoding/);
  assert.match(PROFILE_QUERY_COMMAND, /\$PROFILE$/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/powershell-host.test.ts`
Expected: FAIL，`Cannot find module '../src/powershell-host.ts'`

- [ ] **Step 3: 实现 `discoverPowerShellHosts`**

`src/powershell-host.ts` 要点：

- `PROFILE_QUERY_COMMAND = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Write-Output $PROFILE'`。
- 默认 `query` 用 `spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', PROFILE_QUERY_COMMAND], { encoding: 'utf8', timeout: 10_000, windowsHide: true })`；`result.error` 与 `status !== 0` 都抛 `Error`（信息带 executable、status、stderr 摘要）；返回 `stdout`。
- `findOnPath(pathValue, name)`：按 `pathValue.split(delimiter)`（Windows 上用 `';'`，因为 `platform === 'win32'` 时不能用 POSIX 的 `delimiter`）逐目录 `statSync(join(dir, name)).isFile()`，返回第一个命中。
- 候选顺序（都在 `platform === 'win32'` 下）：`pwsh` → `findOnPath('pwsh.exe') || join(env.ProgramFiles ?? '', 'PowerShell', '7', 'pwsh.exe')`（后者需 `isFile()`）；`windows-powershell` → `findOnPath('powershell.exe') || join(env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')`。
- 对每个找到的候选：`query` 成功且 `trim()` 后非空才加入 `hosts`；抛错或空输出加入 `failures`（空输出信息含「`$PROFILE` returned nothing」）。
- 非 `win32` 直接返回 `{ hosts: [], failures: [] }`。
- 顺序固定：`pwsh` 在前。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/powershell-host.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/powershell-host.ts test/powershell-host.test.ts
git commit -m "feat(powershell): discover hosts and read their \$PROFILE"
```

---

### Task 2: profile 受管块、编码探测与读写

**Files:**
- Modify: `src/shell-integration.ts`（导出标记与受管块工具、让 strip 兼容 CRLF、`updateRc` 支持 EOL 参数、新增 `renderPowerShellFunction`）
- Create: `src/powershell-profile.ts`
- Test: `test/powershell-profile.test.ts`

**Interfaces:**
- Consumes: `renderPowerShellFunction`（本任务新增）；Task 1 的 `PowerShellHost`（本任务不直接用，Task 3 用）。
- Produces:
  - `src/shell-integration.ts` 新导出：`START_MARKER`、`END_MARKER`、`locateManagedBlock(text, source): {start: number; end: number} | undefined`、`updateRc(original, block, source, eol?: string): string`、`stripManagedBlock(original, source): string`、`renderPowerShellFunction(repoRoot: string): string`
  - `src/powershell-profile.ts`：`class ProfileEncodingError extends Error`、`type ProfileContents = { kind: 'missing' } | { kind: 'utf8'; text: string } | { kind: 'utf8-bom'; text: string }`、`readProfileFile(path: string): ProfileContents`、`renderPowerShellBlock(repoRoot: string): string`、`installPowerShellProfiles(options: { profilePaths: readonly string[]; repoRoot: string }): string[]`、`removePowerShellProfiles(options: { profilePaths: readonly string[] }): string[]`、`powerShellProfileCandidates(options: { env: NodeJS.ProcessEnv }): string[]`

- [ ] **Step 1: 写失败的测试**

`test/powershell-profile.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installPowerShellProfiles,
  powerShellProfileCandidates,
  readProfileFile,
  removePowerShellProfiles,
  renderPowerShellBlock,
} from '../src/powershell-profile.ts';

const repoRoot = "/repo's dir/pi-presets";

function makeDir(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-presets-profile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('lists the computed profile candidates', () => {
  const candidates = powerShellProfileCandidates({
    env: { USERPROFILE: '/home/me', OneDrive: '/home/me/OneDrive' },
  });

  assert.deepEqual(candidates, [
    join('/home/me', 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    join('/home/me', 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    join('/home/me/OneDrive', 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    join('/home/me/OneDrive', 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
  ]);
});

test('omits OneDrive candidates when OneDrive is not set', () => {
  const candidates = powerShellProfileCandidates({ env: { USERPROFILE: 'C:\\Users\\me' } });
  assert.equal(candidates.length, 2);
});

test('refuses UTF-16 profiles instead of mangling them', (t) => {
  const directory = makeDir(t);
  const profile = join(directory, 'profile.ps1');
  writeFileSync(profile, Buffer.from('\uFEFFkeep me', 'utf16le'));

  assert.throws(() => readProfileFile(profile), /UTF-16/i);
  assert.throws(
    () => installPowerShellProfiles({ profilePaths: [profile], repoRoot }),
    /UTF-16/i,
  );
  assert.equal(readFileSync(profile).toString('utf16le'), '\uFEFFkeep me');
});

test('creates the profile with a BOM and CRLF and quotes single quotes', (t) => {
  const directory = makeDir(t);
  const profile = join(directory, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');

  assert.deepEqual(installPowerShellProfiles({ profilePaths: [profile], repoRoot }), [profile]);

  const bytes = readFileSync(profile);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8').slice(1);
  assert.ok(text.startsWith('# >>> pi-presets >>>\r\n'), text);
  assert.ok(text.includes("& node '/repo''s dir/pi-presets/src/cli.ts' @args"), text);
  assert.ok(text.endsWith('# <<< pi-presets <<<\r\n'), text);
});

test('install is idempotent and remove restores the original bytes', (t) => {
  const directory = makeDir(t);
  const profile = join(directory, 'profile.ps1');
  const original = 'before\r\nkeep this\r\nafter'; // 末尾无换行：已知且已接受的例外
  writeFileSync(profile, original);

  installPowerShellProfiles({ profilePaths: [profile], repoRoot });
  installPowerShellProfiles({ profilePaths: [profile], repoRoot });
  const installed = readFileSync(profile, 'utf8');
  assert.equal(installed.split('# >>> pi-presets >>>').length - 1, 1);
  assert.equal(installed.split('# <<< pi-presets <<<').length - 1, 1);

  assert.deepEqual(removePowerShellProfiles({ profilePaths: [profile] }), [profile]);
  assert.equal(readFileSync(profile, 'utf8'), `${original}\r\n`);
});

test('aborts before writing any profile when one is malformed', (t) => {
  const directory = makeDir(t);
  const good = join(directory, 'good.ps1');
  const broken = join(directory, 'broken.ps1');
  writeFileSync(broken, '# >>> pi-presets >>>\nleft open\n');

  assert.throws(
    () => installPowerShellProfiles({ profilePaths: [good, broken], repoRoot }),
    /incomplete managed block/i,
  );
  assert.equal(existsSync(good), false);
});

test('skips missing profiles on removal and leaves foreign profiles alone', (t) => {
  const directory = makeDir(t);
  const missing = join(directory, 'missing.ps1');
  const foreign = join(directory, 'foreign.ps1');
  writeFileSync(foreign, "# my own settings\r\nSet-Alias ll Get-ChildItem\r\n");

  assert.deepEqual(removePowerShellProfiles({ profilePaths: [missing, foreign] }), []);
  assert.equal(readFileSync(foreign, 'utf8'), "# my own settings\r\nSet-Alias ll Get-ChildItem\r\n");
});

test('removal strips a block from a CRLF file byte for byte', (t) => {
  const directory = makeDir(t);
  const profile = join(directory, 'profile.ps1');
  const original = 'before\r\n';
  writeFileSync(profile, original);
  installPowerShellProfiles({ profilePaths: [profile], repoRoot });

  removePowerShellProfiles({ profilePaths: [profile] });
  assert.equal(readFileSync(profile, 'utf8'), original);
});

test('renderPowerShellBlock wraps the generated function in markers', () => {
  const block = renderPowerShellBlock('/repo');
  assert.equal(block.split('\r\n')[0], '# >>> pi-presets >>>');
  assert.ok(block.includes('function pi {'));
  assert.equal(block.split('\r\n').at(-1), '# <<< pi-presets <<<');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/powershell-profile.test.ts`
Expected: FAIL，`Cannot find module '../src/powershell-profile.ts'`

- [ ] **Step 3: 改造 `src/shell-integration.ts` 的共享工具**

- `START_MARKER` / `END_MARKER`、`locateManagedBlock`、`updateRc`、`stripManagedBlock` 加 `export`。
- `updateRc(original, block, source, eol = '\n')`：末尾换行判断与分隔空行都用 `eol`。
- `stripManagedBlock(original, source)`：判断上一个 EOL 时同时接受 `\r\n` 与 `\n`（`prefix` 以 `\r\n\r\n` 结尾就去掉一个 `\r\n`，否则以 `\n\n` 结尾去掉一个 `\n`；`suffix` 以 `\r\n` 开头去 `\r\n`，否则以 `\n` 开头去 `\n`）。POSIX 现有行为不变。
- 新增 `renderPowerShellFunction(repoRoot: string): string`：

  ```text
  # Generated by pi-presets setup.
  function pi {
      & node '<cliPath>' @args
  }
  ```

  `cliPath` = `join(repoRoot, 'src', 'cli.ts')`，按 PowerShell 单引号规则转义（`'` → `''`）。行尾用 `\n`（由调用方决定整块的 EOL）。

- [ ] **Step 4: 实现 `src/powershell-profile.ts`**

要点：

- `readProfileFile`：用 `readFileSync(path)` 拿 Buffer。路径不存在返回 `{kind:'missing'}`；`EF BB BF` → `{kind:'utf8-bom', text: rest.toString('utf8')}`；`FF FE` 或 `FE FF` → `throw new ProfileEncodingError('... UTF-16 ... save it as UTF-8 ...')`；否则 `{kind:'utf8', text: buffer.toString('utf8')}`。
- `renderPowerShellBlock(repoRoot)`：`# >>> pi-presets >>>\r\n` + `renderPowerShellFunction(repoRoot)`（把 `\n` 全部换成 `\r\n`）+ `# <<< pi-presets <<<`。
- `installPowerShellProfiles`：**先把所有 profile 读成 `ProfileContents`（含编码与标记校验），全部通过后才写**；写入时新建文件写 UTF-8 BOM + 块 + `\r\n`，已有文件用 `updateRc(text, block, path, '\r\n')` 拼接并原样保留 BOM 状态；父目录用 `mkdirSync(dirname(path), {recursive:true})`。返回真正写入的路径数组（内容已一致的文件也算写入，与 POSIX 行为一致）。
- `removePowerShellProfiles`：同样先读全部、校验标记，再写；`missing` 与「无标记」都跳过，返回真正被剥离的路径数组。
- `powerShellProfileCandidates({env})`：`USERPROFILE` 缺失时返回空数组；用 `node:path` 的 `join`（**不是** `win32.join`）拼接——生产在 win32 上跑，`join` 就是 `win32.join`；用宿主 `join` 才能让 Linux 上的测试造出真实可写的路径。依次 `Documents/PowerShell`、`Documents/WindowsPowerShell`，`OneDrive` 存在时再加两条（顺序见测试）。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/powershell-profile.test.ts test/setup.test.ts`
Expected: PASS（新用例全绿，`setup.test.ts` 无回归）

- [ ] **Step 6: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`

- [ ] **Step 7: Commit**

```bash
git add src/shell-integration.ts src/powershell-profile.ts test/powershell-profile.test.ts
git commit -m "feat(powershell): profile blocks with encoding detection"
```

---

### Task 3: 平台门禁与 setup/teardown 接线

**Files:**
- Create: `src/platform.ts`
- Modify: `src/shell-integration.ts`、`src/setup.ts`、`src/teardown.ts`
- Test: Create `test/shell-integration.test.ts`；Modify `test/setup.test.ts`（追加 PowerShell 场景）

**Interfaces:**
- Consumes: Task 1 的 `discoverPowerShellHosts`、`PowerShellHost`、`PowerShellHostFailure`；Task 2 的 `installPowerShellProfiles`、`removePowerShellProfiles`、`powerShellProfileCandidates`、`readProfileFile`、`renderPowerShellBlock`；`renderPowerShellFunction`。
- Produces:
  - `src/platform.ts`：`currentPlatform(env?: NodeJS.ProcessEnv): NodeJS.Platform`（读 `env.PI_PRESETS_PLATFORM`，否则 `process.platform`）
  - `src/shell-integration.ts`：`type SupportedShell = 'fish' | 'bash' | 'zsh' | 'powershell'`、`const POSIX_SHELLS: readonly ['fish','bash','zsh']`、`supportedShells(platform: NodeJS.Platform): readonly SupportedShell[]`、`isSupportedShell(value: string, platform: NodeJS.Platform): value is SupportedShell`、`renderFunctionSource('powershell', repoRoot)`（委托 `renderPowerShellFunction`）、`renderShortcutHint('powershell')`

- [ ] **Step 1: 写失败的测试（平台矩阵 + PowerShell CLI 行为）**

`test/shell-integration.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { currentPlatform } from '../src/platform.ts';
import {
  isSupportedShell,
  renderFunctionSource,
  renderShortcutHint,
  supportedShells,
} from '../src/shell-integration.ts';

test('currentPlatform accepts the test seam', () => {
  assert.equal(currentPlatform({ PI_PRESETS_PLATFORM: 'win32' }), 'win32');
  assert.equal(currentPlatform({}), process.platform);
});

test('supported shells depend on the platform', () => {
  assert.deepEqual(supportedShells('win32'), ['powershell']);
  for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
    assert.deepEqual(supportedShells(platform), ['fish', 'bash', 'zsh']);
  }
});

test('isSupportedShell rejects cross-platform shells', () => {
  assert.equal(isSupportedShell('powershell', 'win32'), true);
  assert.equal(isSupportedShell('powershell', 'linux'), false);
  assert.equal(isSupportedShell('fish', 'win32'), false);
  assert.equal(isSupportedShell('nu', 'linux'), false);
});

test('renders the powershell function via renderFunctionSource', () => {
  const cliPath = join("/repo's dir", 'src', 'cli.ts').replaceAll("'", "''");
  assert.equal(renderFunctionSource('powershell', "/repo's dir"), [
    '# Generated by pi-presets setup.',
    'function pi {',
    `    & node '${cliPath}' @args`,
    '}',
    '',
  ].join('\n'));
});

test('suggests functions, not aliases, for powershell shortcuts', () => {
  const lines = renderShortcutHint('powershell').join('\n');
  assert.match(lines, /function picode \{ pi -ps coding @args \}/);
  assert.match(lines, /function piwork \{ pi -ps office,design @args \}/);
  assert.ok(!lines.includes('alias '));
});
```

`test/setup.test.ts` 追加（复用文件里已有的 `makeDirectories`、`spawnSync` 风格）：

```ts
test('setup writes both host profiles on Windows', (t) => {
  const directories = makeDirectories(t);
  const hosts = join(directories.directory, 'hosts');
  mkdirSync(hosts, { recursive: true });
  for (const [name, profile] of [
    ['pwsh.exe', join(directories.directory, 'ps7', 'Microsoft.PowerShell_profile.ps1')],
    ['powershell.exe', join(directories.directory, 'ps51', 'Microsoft.PowerShell_profile.ps1')],
  ]) {
    const path = join(hosts, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${profile}'\n`);
    chmodSync(path, 0o755);
  }

  const result = spawnSync(process.execPath, [setupPath], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      USERPROFILE: directories.homeDir,
      PATH: `${hosts}${delimiter}${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(directories.directory, 'ps7', 'Microsoft.PowerShell_profile.ps1')));
  assert.ok(existsSync(join(directories.directory, 'ps51', 'Microsoft.PowerShell_profile.ps1')));
  assert.match(result.stdout, /function picode \{ pi -ps coding @args \}/);
});

test('setup rejects powershell off Windows and fish on Windows', (t) => {
  const directories = makeDirectories(t);
  const offWindows = spawnSync(process.execPath, [setupPath, '--shell', 'powershell'], {
    env: { ...process.env, PI_PRESETS_PLATFORM: 'linux', HOME: directories.homeDir, SHELL: '/bin/bash' },
    encoding: 'utf8',
  });
  const onWindows = spawnSync(process.execPath, [setupPath, '--shell', 'fish'], {
    env: { ...process.env, PI_PRESETS_PLATFORM: 'win32', USERPROFILE: directories.homeDir },
    encoding: 'utf8',
  });

  assert.equal(offWindows.status, 2);
  assert.match(offWindows.stderr, /not supported on this platform/i);
  assert.equal(onWindows.status, 2);
  assert.match(onWindows.stderr, /powershell/i);
});

test('setup fails when no PowerShell host is found', (t) => {
  const directories = makeDirectories(t);
  const result = spawnSync(process.execPath, [setupPath], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      USERPROFILE: directories.homeDir,
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
      PATH: join(directories.directory, 'empty'),
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /pwsh\.exe/);
});

test('setup aborts the whole install when one host query fails', (t) => {
  const directories = makeDirectories(t);
  const hosts = join(directories.directory, 'hosts');
  mkdirSync(hosts, { recursive: true });
  const good = join(hosts, 'powershell.exe');
  writeFileSync(good, `#!/bin/sh\nprintf '%s\\n' '${join(directories.directory, 'ps51', 'profile.ps1')}'\n`);
  chmodSync(good, 0o755);
  const bad = join(hosts, 'pwsh.exe');
  writeFileSync(bad, '#!/bin/sh\nexit 3\n');
  chmodSync(bad, 0o755);

  const result = spawnSync(process.execPath, [setupPath], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      USERPROFILE: directories.homeDir,
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
      PATH: hosts,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(existsSync(join(directories.directory, 'ps51', 'profile.ps1')), false);
});

test('setup --dry-run --shell powershell prints only the function', (t) => {
  const directories = makeDirectories(t);
  const hosts = join(directories.directory, 'hosts');
  mkdirSync(hosts, { recursive: true });
  const host = join(hosts, 'pwsh.exe');
  writeFileSync(host, `#!/bin/sh\nprintf '%s\\n' '${join(directories.directory, 'ps7', 'profile.ps1')}'\n`);
  chmodSync(host, 0o755);

  const result = spawnSync(process.execPath, [setupPath, '--dry-run', '--shell', 'powershell'], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      USERPROFILE: directories.homeDir,
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
      PATH: hosts,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, renderFunctionSource('powershell', repoRoot));
  assert.equal(existsSync(join(directories.directory, 'ps7', 'profile.ps1')), false);
  assert.match(result.stderr, /Would write/);
});

test('teardown still strips the computed candidates when a host is broken', (t) => {
  const directories = makeDirectories(t);
  const profile = join(directories.homeDir, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
  mkdirSync(dirname(profile), { recursive: true });
  writeFileSync(profile, '# >>> pi-presets >>>\nfunction pi { }\n# <<< pi-presets <<<\n');

  const result = spawnSync(process.execPath, [teardownPath], {
    env: {
      ...process.env,
      PI_PRESETS_PLATFORM: 'win32',
      USERPROFILE: directories.homeDir,
      PATH: join(directories.directory, 'empty'),
      ProgramFiles: join(directories.directory, 'none'),
      SystemRoot: join(directories.directory, 'none'),
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(profile, 'utf8'), '');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/shell-integration.test.ts test/setup.test.ts`
Expected: FAIL（`currentPlatform` 不存在；`--shell powershell` 被当未知；Windows 用例全红）

- [ ] **Step 3: 实现 `src/platform.ts` 与 shell 集合**

- `currentPlatform`：`const override = env.PI_PRESETS_PLATFORM; return (override || process.platform) as NodeJS.Platform;`
- `shell-integration.ts`：`SupportedShell` 加 `'powershell'`；`SUPPORTED_SHELLS` 改名 `POSIX_SHELLS`（同步 `teardown.ts` 的引用）；`supportedShells(platform)` 如测试；`isSupportedShell(value, platform)`；`renderFunctionSource` 对 `'powershell'` 返回 `renderPowerShellFunction(repoRoot)`；`renderShortcutHint` 对 powershell 输出 `function picode { pi -ps coding @args }` / `function piwork { pi -ps office,design @args }`。
- `shellIntegrationPaths` / `installShellIntegration` / `removeShellIntegration` 的 `shell` 参数收窄为 `Exclude<SupportedShell, 'powershell'>`（类型层面排除，实现不变）。PowerShell 的安装/卸载走 `powershell-profile.ts` 的批量函数：两阶段校验需要跨文件，塞进单文件 API 里做不到。

- [ ] **Step 4: 接线 `setup.ts`**

- 平台取自 `currentPlatform(process.env)`；候选 shell 为 `supportedShells(platform)`。
- 缺省 shell：`win32` → `'powershell'`；其他平台仍取 `basename(process.env.SHELL ?? '')`（**不做宿主版本探测**，Windows 上唯一可选值就是 powershell）。
- 报错文案随平台列出可选项（`supportedShells(platform).join(', ')`）。
- `setup --shell powershell` 分支：
  1. `discoverPowerShellHosts({platform, env: process.env, pathValue: process.env.PATH ?? ''})`。
  2. `failures.length > 0` → 打印每个失败的宿主机与原因，退出码 1，不写文件。
  3. `hosts.length === 0` → 打印搜索过的四个位置，提示装 PowerShell 7 或检查 PATH，退出码 1。
  4. `installPowerShellProfiles({profilePaths: hosts.map(h => h.profilePath), repoRoot})`。
  5. 打印写入清单 + 每个宿主的 `Restart PowerShell, or run this in it: . '<profilePath>'` + 简写提示（`renderShortcutHint('powershell')`）。
- `--dry-run` 分支（POSIX 行为不变）：`shell === 'powershell'` 时 stdout 写 `renderFunctionSource('powershell', repoRoot)`，stderr 写「不会写盘」「将写入：<宿主 profile 列表或搜索失败说明>」，TTY 时额外打印：

  ```text
  [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; Invoke-Expression (& npm.cmd run --silent setup -- --dry-run --shell powershell | Out-String)
  ```

- POSIX 分支保持现有输出不变。

- [ ] **Step 5: 接线 `teardown.ts`**

- 缺省 `shells`：`supportedShells(currentPlatform(process.env))`。
- `shell` 取值必须属于当前平台的集合，否则退出码 2。
- 平台为 `win32` 时：`discoverPowerShellHosts(...)`；有 `failures` 就在 stderr 打印「宿主 X 查询失败，已退回路径扫描」，**不改变退出码**；候选路径 = 宿主 profilePath ∪ `powerShellProfileCandidates({env: process.env})` 去重；`removePowerShellProfiles({profilePaths})` 的返回值作为 `rcFiles` 打印（沿用「Stripped the managed block from」措辞）。
- 非 win32 平台的 PowerShell 分支直接不走（门禁已排除）。
- 现有 POSIX 输出与退出码不变。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test test/shell-integration.test.ts test/setup.test.ts`
Expected: PASS

- [ ] **Step 7: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`

- [ ] **Step 8: Commit**

```bash
git add src/platform.ts src/shell-integration.ts src/setup.ts src/teardown.ts test/shell-integration.test.ts test/setup.test.ts
git commit -m "feat(powershell): gate shells by platform and wire setup/teardown"
```

---

### Task 4: Windows 上启动真实 pi

**Files:**
- Create: `src/windows-command.ts`
- Modify: `src/cli.ts`
- Test: `test/windows-command.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `interface RealPiCommand { path: string; kind: 'direct' | 'cmd' }`
  - `interface ResolveRealPiOptions { pathValue: string; platform: NodeJS.Platform; pathExt: string }`
  - `function resolveRealPi(options: ResolveRealPiOptions): RealPiCommand`
  - `function quoteForCmd(argument: string): string`
  - `function buildCmdCommandLine(command: RealPiCommand, args: readonly string[]): string`
  - `function spawnSpec(command: RealPiCommand, args: readonly string[]): { file: string; args: string[]; windowsVerbatimArguments: boolean }`

- [ ] **Step 1: 写失败的测试**

`test/windows-command.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCmdCommandLine,
  quoteForCmd,
  resolveRealPi,
  spawnSpec,
} from '../src/windows-command.ts';

const PATH_EXT = '.COM;.EXE;.BAT;.CMD';

function makeDir(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-presets-win-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function touch(path: string): void {
  writeFileSync(path, 'x');
  chmodSync(path, 0o755);
}

test('POSIX keeps the existing lookup', (t) => {
  const directory = makeDir(t);
  touch(join(directory, 'pi'));

  assert.deepEqual(
    resolveRealPi({ pathValue: directory, platform: 'linux', pathExt: PATH_EXT }),
    { path: join(directory, 'pi'), kind: 'direct' },
  );
});

test('Windows follows PATHEXT and skips the extensionless sh script', (t) => {
  const directory = makeDir(t);
  touch(join(directory, 'pi'));
  touch(join(directory, 'pi.cmd'));

  assert.deepEqual(
    resolveRealPi({ pathValue: directory, platform: 'win32', pathExt: PATH_EXT }),
    { path: join(directory, 'pi.cmd'), kind: 'cmd' },
  );
});

test('Windows prefers earlier PATH entries and earlier PATHEXT entries', (t) => {
  const first = makeDir(t);
  const second = makeDir(t);
  touch(join(first, 'pi.exe'));
  touch(join(second, 'pi.cmd'));

  assert.equal(
    resolveRealPi({ pathValue: `${first};${second}`, platform: 'win32', pathExt: PATH_EXT }).path,
    join(first, 'pi.exe'),
  );

  rmSync(join(first, 'pi.exe'));
  touch(join(first, 'pi.cmd'));
  touch(join(first, 'pi.bat'));
  assert.equal(
    resolveRealPi({ pathValue: first, platform: 'win32', pathExt: '.BAT;.CMD;.EXE' }).path,
    join(first, 'pi.bat'),
  );
});

test('reports a missing pi with the searched names', (t) => {
  const directory = makeDir(t);
  assert.throws(
    () => resolveRealPi({ pathValue: directory, platform: 'win32', pathExt: PATH_EXT }),
    /pi is not on PATH.*pi\.exe.*pi\.cmd/i,
  );
});

test('quotes arguments for cmd', () => {
  assert.equal(quoteForCmd(''), '""');
  assert.equal(quoteForCmd('plain'), 'plain');
  assert.equal(quoteForCmd('two words'), '"two words"');
  assert.equal(quoteForCmd('a&b'), 'a^&b');
  assert.equal(quoteForCmd('a&b c'), '"a&b c"');
  assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteForCmd('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(quoteForCmd('100%'), '100%');
  assert.equal(quoteForCmd('bang!'), 'bang!');
  assert.equal(quoteForCmd('中文'), '中文');
});

test('builds a /s command line that survives spaces', (t) => {
  const directory = makeDir(t);
  touch(join(directory, 'pi.cmd'));
  const command = resolveRealPi({ pathValue: directory, platform: 'win32', pathExt: PATH_EXT });

  assert.equal(
    buildCmdCommandLine(command, ['-ps', 'coding', '-p', 'list ts files']),
    `""${join(directory, 'pi.cmd')}" -ps coding -p "list ts files""`,
  );
});

test('spawns .cmd through the command processor and .exe directly', (t) => {
  const directory = makeDir(t);
  const exe = join(directory, 'pi.exe');
  touch(exe);

  assert.deepEqual(spawnSpec({ path: exe, kind: 'direct' }, ['-ps', 'coding']), {
    file: exe,
    args: ['-ps', 'coding'],
    windowsVerbatimArguments: false,
  });

  const cmd = { path: join(directory, 'pi.cmd'), kind: 'cmd' as const };
  const spec = spawnSpec(cmd, ['-ps', 'coding']);
  assert.match(spec.file, /cmd\.exe$/i);
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/windows-command.test.ts`
Expected: FAIL，`Cannot find module '../src/windows-command.ts'`

- [ ] **Step 3: 实现 `src/windows-command.ts`**

- `resolveRealPi`：非 win32 → 沿用现有 `pi` + `X_OK`（找不到时的错误信息沿用现有措辞）；win32 → 扩展名列表 = `pathExt.split(';')` 过滤非空、转小写，逐个目录（按 `';'` 切 `pathValue`）按扩展名顺序找 `pi${ext}` 且 `isFile()`；`.exe`/`.com` → `kind: 'direct'`，`.cmd`/`.bat` → `kind: 'cmd'`。找不到时抛错，信息形如 `pi is not on PATH (looked for pi.exe, pi.com, pi.bat, pi.cmd)`。
- `quoteForCmd`：空串 → `""`；无 `"`、无空白、无 `&|<>^()` → 原样（`%`、`!` 也原样）；无 `"` 且无空白但含 `&|<>^()` → 每个元字符前加 `^`；含空白或 `"` → 用 `"` 包起来，内部按 MSVCRT 规则把 `\` 加倍后再转义 `"`（尾部连续反斜杠也要加倍）。引号内不再加 `^`。
- `buildCmdCommandLine(command, args)`：`""${command.path}" ${args.map(quoteForCmd).join(' ')}"`。
- `spawnSpec(command, args)`：`direct` → `{file: path, args, windowsVerbatimArguments: false}`；`cmd` → `{file: process.env.ComSpec ?? 'cmd.exe', args: ['/d','/s','/c', buildCmdCommandLine(command, args)], windowsVerbatimArguments: true}`。
- `cli.ts`：`findRealPi` 换成 `resolveRealPi({pathValue: process.env.PATH ?? '', platform: process.platform, pathExt: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'})`，`runPi` 用 `spawnSpec(...)` 的 `file/args/windowsVerbatimArguments`；信号处理与退出码映射保持不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/windows-command.test.ts test/cli.test.ts`
Expected: PASS（`cli.test.ts` 的假 pi 走 POSIX 路径，不应有回归）

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/windows-command.ts src/cli.ts test/windows-command.test.ts
git commit -m "feat(windows): resolve and spawn the real pi shim"
```

---

### Task 5: `postinstall` 在 Windows 上找得到 npm

**Files:**
- Modify: `src/install-presets.ts`
- Test: `test/install-presets.test.ts`（追加）

**Interfaces:**
- Consumes: 现有 `installPresetDependencies({repoRoot, runner})`。
- Produces: `function resolveNpmCommand(options: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; args: readonly string[] }): { command: string; args: string[] }`

- [ ] **Step 1: 写失败的测试**

在 `test/install-presets.test.ts` 追加（复用文件已有的 `makeTree` / `addPreset`）：

```ts
import { resolveNpmCommand } from '../src/install-presets.ts';

test('prefers the npm executable that started the lifecycle script', () => {
  const resolved = resolveNpmCommand({
    env: { npm_execpath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js' },
    platform: 'win32',
    args: ['ci'],
  });

  assert.deepEqual(resolved, {
    command: process.execPath,
    args: ['/usr/local/lib/node_modules/npm/bin/npm-cli.js', 'ci'],
  });
});

test('falls back to cmd.exe on Windows and to npm elsewhere', () => {
  assert.deepEqual(
    resolveNpmCommand({ env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, platform: 'win32', args: ['ci'] }),
    { command: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', 'npm ci'] },
  );
  assert.deepEqual(
    resolveNpmCommand({ env: {}, platform: 'linux', args: ['ci'] }),
    { command: 'npm', args: ['ci'] },
  );
});

test('runs the resolved npm command for each preset', async (t) => {
  const root = makeTree(t);
  addPreset(root, 'alpha', { dependencies: { a: '1.0.0' } });
  const calls: { command: string; args: string[] }[] = [];

  const installed = await installPresetDependencies({
    repoRoot: root,
    env: { npm_execpath: '/npm-cli.js' },
    platform: 'win32',
    runner: async (command, args) => {
      calls.push({ command, args });
    },
  });

  assert.deepEqual(installed, ['alpha']);
  assert.deepEqual(calls, [{ command: process.execPath, args: ['/npm-cli.js', 'install'] }]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/install-presets.test.ts`
Expected: FAIL，`resolveNpmCommand is not a function` / 断言不符

- [ ] **Step 3: 实现**

- `resolveNpmCommand`：`env.npm_execpath` 非空 → `{command: process.execPath, args: [npmExecPath, ...args]}`；否则 `platform === 'win32'` → `{command: env.ComSpec ?? 'cmd.exe', args: ['/d','/s','/c', ['npm', ...args].join(' ')]}`；否则 `{command: 'npm', args: [...args]}`。
- `InstallPresetOptions` 增加可选 `env?: NodeJS.ProcessEnv`（缺省 `process.env`）与 `platform?: NodeJS.Platform`（缺省 `process.platform`）；循环里 `const resolved = resolveNpmCommand({env, platform, args: [command]}); await runner(resolved.command, resolved.args, {...})`。
- **现有测试要跟着改一处**：第一个用例断言 `command: 'npm'`，默认读 `process.env` 时在 `npm test` 下会拿到 `npm_execpath` 而变成 `process.execPath`。给它显式传 `env: {}`，让它只验证「每个 preset 用哪个 npm 子命令」，与运行环境解耦。
- 现有 `npm` 直调路径在 Linux 上的行为保持不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/install-presets.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/install-presets.ts test/install-presets.test.ts
git commit -m "fix(windows): resolve npm for the postinstall step"
```

---

### Task 6: README 与已知限制

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 3 的 CLI 行为、Task 4 的启动规则、Task 5 的 postinstall 行为。
- Produces: 无代码接口。

- [ ] **Step 1: 更新 Setup 章节**

- 说明支持的 shell 随平台不同：Windows 只有 `powershell`；Linux/macOS 是 fish/bash/zsh。
- Windows 的安装与生效：`npm install && npm run setup` 会写本机所有找到的 PowerShell 宿主（7 与 5.1）的 profile；`exec "$SHELL"` 换成「重启 PowerShell，或 `. $PROFILE`」。
- `--shell powershell` 只能显式用在 Windows 上，其他平台报错退出码 2。

- [ ] **Step 2: 更新 dry-run 与简写章节**

- PowerShell 的 dry-run 用法（必须带编码设置）：

  ```powershell
  [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8
  Invoke-Expression (& npm.cmd run --silent setup -- --dry-run --shell powershell | Out-String)
  ```

- 简写示例补 PowerShell 的函数写法：

  ```powershell
  function picode { pi -ps coding @args }
  function piwork { pi -ps office,design @args }
  ```

- 卸载章节补 Windows：`npm run teardown` 会剥离 7 与 5.1 两个 profile 里的受管块；`--shell powershell` 只处理 Windows。

- [ ] **Step 3: 加「已知限制（Windows）」小节**

- 参数含 `%VAR%` 或 `!` 时，经 `cmd.exe` 的转发会被 cmd 改写。
- Windows PowerShell 5.1 与 PowerShell 7 对含内嵌引号/尾部反斜杠的参数处理不同（`$PSNativeCommandArgumentPassing`）。
- profile 若被另存为 UTF-16，`setup`/`teardown` 会拒绝处理并退出码 1，请另存为 UTF-8。
- 用户定义 `Set-Alias pi ...` 会遮蔽包装函数（别名优先级高于函数）。
- 用户自定义到别处的 profile 不会被扫描到（除宿主报告的那条）。
- 真实冒烟需要一台 Windows：两个宿主各跑一次 `pi -ps coding`。

- [ ] **Step 4: 校验文档里的命令**

Run: `npm run setup -- --dry-run --shell bash`（确认非 Windows 的 dry-run 行为没被改动）
Expected: stdout 是 bash 函数定义，stderr 提到将写入的路径

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document Windows PowerShell support"
```

---

## 交付前检查

- [ ] `npm run typecheck && npm test` 全绿。
- [ ] `git status` 干净；每个任务一个提交。
- [ ] 明确告知人类伙伴：真实 Windows 冒烟（pwsh 7 + 5.1、含中文路径、含空格/`&` 的 prompt）尚未执行，本机无法执行。
