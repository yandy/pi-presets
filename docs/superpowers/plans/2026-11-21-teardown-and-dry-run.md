# setup 卸载与 dry-run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 pi-presets 的 shell 集成补上 `setup --dry-run`（不落盘、输出可 eval 代码）和 `npm run teardown`（卸载集成），并保证「安装后卸载」逐字节回到安装前状态。

**Architecture:** `src/shell-integration.ts` 保留全部渲染与标记逻辑，新增 `renderFunctionSource`、`shellIntegrationPaths`、`removeShellIntegration` 三个导出，使安装、dry-run、卸载共用同一份代码与同一套标记常量。`src/setup.ts` 与新的 `src/teardown.ts` 只做参数解析与输出编排，都不自己拼 shell 代码。

**Tech Stack:** Node.js 22.19+ ESM（原生运行 `.ts`）、Node 内置 `node:test`、fish/bash/zsh、npm。

**Spec:** `docs/superpowers/specs/2026-11-21-teardown-and-dry-run-design.md`

## Global Constraints

- `--dry-run` 不写任何文件，也不创建 `$XDG_CONFIG_HOME/pi-presets` 目录；stdout 恰好是函数文件内容，无其他字节。
- 必须用 `npm run --silent`，否则 npm 横幅会被一起 `eval`。
- teardown 幂等：没装过是空操作，退出码 0；用法错误（未知选项、`--shell` 缺值或不支持）退出码 2；其它失败 1。
- 标记块外的 rc 字节不得改变：`install` 后 `remove` 必须让 rc 逐字节回到安装前内容。
- 标记只出现一半或顺序错乱时，报 `incomplete managed block` 且**一个文件都不修改**。
- `$XDG_CONFIG_HOME/pi-presets/pi.sh` 由 bash 与 zsh 共用；还有 rc 引用受管块时不得删除。
- 剥离后 rc 为空字符串时保留该空文件，不删除用户 dotfile。
- fish 只删除 `conf.d/pi-presets.fish`，不删 `conf.d`；`pi-presets` 目录清空后才 `rmdir`。
- 仓库路径可含空格、单引号、`$`，生成代码必须正确引用。
- 不新增运行时依赖、不引入测试框架、不使用 npm workspaces。
- 脚本名用 `teardown`（不用 `uninstall`，避免与 npm `uninstall` 生命周期同名）。

## Review Focus

- 忘了 `--silent` 时 npm 横幅会进入 `eval`：`--dry-run` 的 stdout 必须零杂音（Task 3 逐字节断言）。
- 用户手改 residual 标记块：teardown 必须整体中止、不写任何文件（Task 2）。
- zsh 仍注册时 `teardown --shell bash` 不得删掉共享的 `pi.sh`（Task 2、Task 4）。
- 安装前不存在的 rc、空 rc 的往返：不残留受管块，也不删掉空文件（Task 2）。
- 仓库路径含空格/引号/`$` 时 eval 出来的函数仍能定位 `src/cli.ts`（Task 3 的 shell 烟雾测试）。

---

### Task 1: 抽出渲染与路径 helper（行为不变的重构）

**Files:**
- Modify: `src/shell-integration.ts`
- Test: `test/setup.test.ts`

**Interfaces:**
- Produces:
  - `renderFunctionSource(shell: SupportedShell, repoRoot: string): string`
  - `shellIntegrationPaths(shell: SupportedShell, homeDir: string, configHome: string): string[]`
  - `installShellIntegration(options: ShellIntegrationOptions): ShellIntegrationResult` 语义与返回顺序不变（posix 为 `[pi.sh, rc]`，fish 为 `[conf.d 文件]`）。

- [ ] **Step 1: 写失败测试**

在 `test/setup.test.ts` 追加（`import` 中补 `renderFunctionSource`, `shellIntegrationPaths`）：

```ts
test('renderFunctionSource matches the installed function file', (t) => {
  const directories = makeDirectories(t);
  installShellIntegration({ shell: 'bash', repoRoot: '/repo with space', ...directories });
  assert.equal(
    readFileSync(join(directories.configHome, 'pi-presets', 'pi.sh'), 'utf8'),
    renderFunctionSource('bash', '/repo with space'),
  );
});

test('shellIntegrationPaths lists exactly what install reports', (t) => {
  const directories = makeDirectories(t);
  for (const shell of ['fish', 'bash', 'zsh'] as const) {
    const options = { shell, repoRoot: directories.directory, ...directories };
    assert.deepEqual(
      installShellIntegration(options).files,
      shellIntegrationPaths(shell, directories.homeDir, directories.configHome),
    );
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/setup.test.ts`
Expected: FAIL，`renderFunctionSource` / `shellIntegrationPaths` 不是可导入的导出。

- [ ] **Step 3: 实现两个 helper**

把现有 `renderFunction(shell, cliPath)` 换成 `renderFunctionSource(shell, repoRoot)`，内部自行拼 `join(repoRoot, 'src', 'cli.ts')`；把函数文件路径与 rc 路径的计算收进 `shellIntegrationPaths(shell, homeDir, configHome)`，`installShellIntegration` 改成调用它取路径后再写入。

- [ ] **Step 4: 跑测试与类型检查**

Run: `node --test test/setup.test.ts && npm run typecheck`
Expected: 全部 PASS（含原有 12 个 setup 用例），typecheck 无输出。

- [ ] **Step 5: 提交**

```bash
git add src/shell-integration.ts test/setup.test.ts
git commit -m "refactor: expose renderFunctionSource and shellIntegrationPaths"
```

---

### Task 2: 卸载逻辑 `removeShellIntegration`

**Files:**
- Modify: `src/shell-integration.ts`
- Test: `test/setup.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `shellIntegrationPaths`、`START_MARKER` / `END_MARKER` 常量。
- Produces:

```ts
export interface RemovalOptions {
  shells: readonly SupportedShell[];
  homeDir: string;
  configHome: string;
  dryRun?: boolean;
}
export interface RemovalResult {
  files: string[];     // 已删除或 dry-run 下将删除的路径
  rcFiles: string[];   // 已剥离或 dry-run 下将剥离的 rc
  keptFiles: string[]; // 有意保留（例如仍被其它 rc 引用的 pi.sh）
}
export function removeShellIntegration(options: RemovalOptions): RemovalResult
```

- [ ] **Step 1: 写失败测试**

在 `test/setup.test.ts` 追加（补导入 `removeShellIntegration`）：

```ts
test('removing integration restores the rc file byte for byte', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  const original = 'before\nkeep this\nafter\n';
  writeFileSync(rcPath, original);
  const install = { shell: 'bash' as const, repoRoot: directories.directory, ...directories };
  installShellIntegration(install);
  installShellIntegration(install);

  const result = removeShellIntegration({
    shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome,
  });

  assert.equal(readFileSync(rcPath, 'utf8'), original);
  assert.deepEqual(result.rcFiles, [rcPath]);
  assert.deepEqual(result.files, [join(directories.configHome, 'pi-presets', 'pi.sh')]);
  assert.ok(!existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
});

test('removing integration leaves no managed block for a missing or empty rc', (t) => {
  const directories = makeDirectories(t);
  for (const shell of ['bash', 'zsh'] as const) {
    installShellIntegration({ shell, repoRoot: directories.directory, ...directories });
    removeShellIntegration({
      shells: [shell], homeDir: directories.homeDir, configHome: directories.configHome,
    });
    const rcPath = join(directories.homeDir, `.${shell}rc`);
    assert.ok(existsSync(rcPath));
    assert.equal(readFileSync(rcPath, 'utf8'), '');
  }
});

test('removing integration preserves content that follows the managed block', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  writeFileSync(rcPath, 'before\n# >>> pi-presets >>>\nold\n# <<< pi-presets <<<\nkeep me\n');

  removeShellIntegration({
    shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome,
  });

  assert.equal(readFileSync(rcPath, 'utf8'), 'before\nkeep me\n');
});

test('removing integration aborts on an incomplete managed block', (t) => {
  const directories = makeDirectories(t);
  const bashrc = join(directories.homeDir, '.bashrc');
  const zshrc = join(directories.homeDir, '.zshrc');
  const original = 'keep me\n# >>> pi-presets >>>\nold\n';
  writeFileSync(bashrc, original);
  writeFileSync(zshrc, 'zsh content\n');
  installShellIntegration({ shell: 'zsh', repoRoot: directories.directory, ...directories });

  assert.throws(() => removeShellIntegration({
    shells: ['bash', 'zsh'], homeDir: directories.homeDir, configHome: directories.configHome,
  }), /incomplete managed block/i);
  assert.equal(readFileSync(bashrc, 'utf8'), original);
  assert.match(readFileSync(zshrc, 'utf8'), /# >>> pi-presets >>>/);
});

test('keeps the shared posix function file while another rc still references it', (t) => {
  const directories = makeDirectories(t);
  for (const shell of ['bash', 'zsh'] as const) {
    installShellIntegration({ shell, repoRoot: directories.directory, ...directories });
  }
  const functionPath = join(directories.configHome, 'pi-presets', 'pi.sh');

  const result = removeShellIntegration({
    shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome,
  });

  assert.ok(existsSync(functionPath));
  assert.deepEqual(result.keptFiles, [functionPath]);
  assert.doesNotMatch(readFileSync(join(directories.homeDir, '.bashrc'), 'utf8'), /pi-presets/);
  assert.match(readFileSync(join(directories.homeDir, '.zshrc'), 'utf8'), /# >>> pi-presets >>>/);
});

test('removing fish integration deletes only the conf.d file', (t) => {
  const directories = makeDirectories(t);
  installShellIntegration({ shell: 'fish', repoRoot: directories.directory, ...directories });
  const integrationPath = join(directories.configHome, 'fish', 'conf.d', 'pi-presets.fish');

  const result = removeShellIntegration({
    shells: ['fish'], homeDir: directories.homeDir, configHome: directories.configHome,
  });

  assert.deepEqual(result.files, [integrationPath]);
  assert.ok(!existsSync(integrationPath));
  assert.ok(existsSync(join(directories.configHome, 'fish', 'conf.d')));
});

test('dry run reports the plan without touching any file', (t) => {
  const directories = makeDirectories(t);
  const rcPath = join(directories.homeDir, '.bashrc');
  installShellIntegration({ shell: 'bash', repoRoot: directories.directory, ...directories });
  const installed = readFileSync(rcPath, 'utf8');

  const result = removeShellIntegration({
    shells: ['bash'], homeDir: directories.homeDir, configHome: directories.configHome, dryRun: true,
  });

  assert.deepEqual(result.rcFiles, [rcPath]);
  assert.equal(readFileSync(rcPath, 'utf8'), installed);
  assert.ok(existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/setup.test.ts`
Expected: FAIL，`removeShellIntegration` 不是可导入的导出。

- [ ] **Step 3: 实现 `removeShellIntegration`**

实现要点（算法由签名与测试决定，这里只点明取舍）：

1. 先为每个 posix shell 读 rc，用与 `updateRc` 同一套标记定位剥离后的内容，全部校验通过后才落盘（满足「任一不完整则整体不修改」）。
2. 剥离时同时吞掉块一侧多余的一个换行：前缀结尾是 `\n\n` 去一个 `\n`，块后紧跟 `\n` 去一个 `\n`。这正好抵消安装时「块前一个空行、块后一个换行」的追加格式。
3. 删除 fish 文件；posix 函数文件在所有 rc 剥离结果都不再含 `START_MARKER` 且无 `dryRun` 时删除，`pi-presets` 目录 `rmdir` 失败即忽略；否则进 `keptFiles`。
4. `dryRun` 为真时只计算并返回，不写盘、不删除。

- [ ] **Step 4: 跑测试与类型检查**

Run: `node --test test/setup.test.ts && npm run typecheck`
Expected: 全部 PASS，typecheck 无输出。

- [ ] **Step 5: 提交**

```bash
git add src/shell-integration.ts test/setup.test.ts
git commit -m "feat: add removeShellIntegration with dry-run support"
```

---

### Task 3: `setup --dry-run`

**Files:**
- Modify: `src/setup.ts`
- Test: `test/setup.test.ts`

**Interfaces:**
- Consumes: `renderFunctionSource`、`shellIntegrationPaths`（Task 1）。
- Produces: CLI 契约 `node src/setup.ts [--shell fish|bash|zsh] [--dry-run]`；`--dry-run` 时 stdout 精确等于函数文件内容，人类提示全在 stderr。

- [ ] **Step 1: 写失败测试**

在 `test/setup.test.ts` 追加（`setupPath` 已存在；文件顶部补 `const repoRoot = fileURLToPath(new URL('../', import.meta.url));`）：

```ts
test('setup --dry-run prints the function source and writes nothing', (t) => {
  const directories = makeDirectories(t);
  const result = spawnSync(process.execPath, [setupPath, '--dry-run', '--shell', 'bash'], {
    env: { ...process.env, HOME: directories.homeDir, XDG_CONFIG_HOME: directories.configHome, SHELL: '/bin/fish' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, renderFunctionSource('bash', repoRoot));
  assert.ok(!existsSync(join(directories.homeDir, '.bashrc')));
  assert.ok(!existsSync(join(directories.configHome, 'pi-presets')));
  assert.match(result.stderr, /dry run/i);
});

test('setup --dry-run output evaluates into a working function', {
  skip: spawnSync('sh', ['-c', 'command -v "$1"', 'shell-lookup', 'bash'], { encoding: 'utf8' }).status !== 0,
  timeout: 5000,
}, (t) => {
  const directories = makeDirectories(t);
  const repoRootWithQuotes = join(directories.directory, "repo with ' quote and $dollar");
  const bin = join(directories.directory, 'bin');
  const cwd = join(directories.directory, 'work');
  const capture = join(directories.directory, 'capture.json');
  mkdirSync(bin);
  mkdirSync(cwd);
  mkdirSync(join(repoRootWithQuotes, 'coding'), { recursive: true });
  cpSync(sourceDirectory, join(repoRootWithQuotes, 'src'), { recursive: true });
  writeFileSync(join(repoRootWithQuotes, 'coding', 'package.json'), '{"name":"coding"}');
  const fakePi = join(bin, 'pi');
  writeFileSync(fakePi, `#!${process.execPath}\n`
    + "const fs = require('node:fs');\n"
    + 'fs.writeFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n');
  chmodSync(fakePi, 0o755);

  const dryRun = spawnSync(
    process.execPath,
    [join(repoRootWithQuotes, 'src', 'setup.ts'), '--dry-run', '--shell', 'bash'],
    { env: { ...process.env, HOME: directories.homeDir, XDG_CONFIG_HOME: directories.configHome }, encoding: 'utf8' },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);

  const result = spawnSync('bash', ['-c', 'eval "$1"; pi -ps coding -p hello', 'pi-presets-test', dryRun.stdout], {
    cwd,
    env: {
      ...process.env,
      HOME: directories.homeDir,
      PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
      FAKE_PI_CAPTURE: capture,
    },
    encoding: 'utf8',
    timeout: 4000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
    argv: ['-e', join(repoRootWithQuotes, 'coding'), '-p', 'hello'],
    cwd,
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/setup.test.ts`
Expected: FAIL，`Unknown setup option: --dry-run`（退出码 2）。

- [ ] **Step 3: 实现 `--dry-run`**

`parseShell` 改名为返回 `{ shell, dryRun }` 的解析函数，按现有风格逐项读取 `--dry-run` / `--shell <value>`，未知选项仍报 `Unknown setup option: ${argument}`，`--shell` 缺值仍报 `--shell requires fish, bash, or zsh.`。`dryRun` 分支：

1. `process.stdout.write(renderFunctionSource(shell, repoRoot))`，不做任何写盘（不调用 `installShellIntegration`）。
2. stderr 打印 `Dry run: no files written for ${shell}.` 与 `Would write: ${shellIntegrationPaths(...).join(', ')}`。
3. `process.stdout.isTTY` 为真时再往 stderr 打印 eval 用法：fish 为 `eval (npm run --silent setup -- --dry-run --shell fish)`，其余为 `eval "$(npm run --silent setup -- --dry-run --shell bash)"`。
4. 非 dry-run 分支保持现有输出与重载提示不变。

- [ ] **Step 4: 跑测试与类型检查**

Run: `node --test test/setup.test.ts && npm run typecheck`
Expected: 全部 PASS，typecheck 无输出。

- [ ] **Step 5: 提交**

```bash
git add src/setup.ts test/setup.test.ts
git commit -m "feat: add setup --dry-run that prints eval-able shell code"
```

---

### Task 4: `src/teardown.ts` 入口与 npm script

**Files:**
- Create: `src/teardown.ts`
- Modify: `package.json`（`scripts` 增加 `"teardown": "node src/teardown.ts"`）
- Test: `test/setup.test.ts`

**Interfaces:**
- Consumes: `removeShellIntegration`、`SUPPORTED_SHELLS`、`isSupportedShell`（Task 2）。
- Produces: CLI 契约 `node src/teardown.ts [--shell fish|bash|zsh] [--dry-run]`；缺省清理 fish、bash、zsh 三处。

- [ ] **Step 1: 写失败测试**

在 `test/setup.test.ts` 追加（顶部补 `const teardownPath = fileURLToPath(new URL('../src/teardown.ts', import.meta.url));`）：

```ts
function runTeardown(directories: TestDirectories, args: readonly string[]) {
  return spawnSync(process.execPath, [teardownPath, ...args], {
    env: { ...process.env, HOME: directories.homeDir, XDG_CONFIG_HOME: directories.configHome, SHELL: '/bin/fish' },
    encoding: 'utf8',
  });
}

test('teardown removes every registration by default', (t) => {
  const directories = makeDirectories(t);
  const rcPaths = ['bash', 'zsh'].map((shell) => join(directories.homeDir, `.${shell}rc`));
  for (const shell of ['fish', 'bash', 'zsh'] as const) {
    installShellIntegration({ shell, repoRoot: directories.directory, ...directories });
  }

  const result = runTeardown(directories, []);

  assert.equal(result.status, 0, result.stderr);
  for (const rcPath of rcPaths) assert.equal(readFileSync(rcPath, 'utf8'), '');
  assert.ok(!existsSync(join(directories.configHome, 'fish', 'conf.d', 'pi-presets.fish')));
  assert.ok(!existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
  assert.ok(!existsSync(join(directories.configHome, 'pi-presets')));
});

test('teardown is a no-op when nothing is installed', (t) => {
  const directories = makeDirectories(t);
  const result = runTeardown(directories, []);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to remove/i);
});

test('teardown --shell bash keeps the shared function file for zsh', (t) => {
  const directories = makeDirectories(t);
  for (const shell of ['bash', 'zsh'] as const) {
    installShellIntegration({ shell, repoRoot: directories.directory, ...directories });
  }

  const result = runTeardown(directories, ['--shell', 'bash']);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
  assert.match(result.stdout, /pi\.sh/);
  assert.match(readFileSync(join(directories.homeDir, '.zshrc'), 'utf8'), /# >>> pi-presets >>>/);
});

test('teardown --dry-run changes nothing', (t) => {
  const directories = makeDirectories(t);
  installShellIntegration({ shell: 'bash', repoRoot: directories.directory, ...directories });
  const installed = readFileSync(join(directories.homeDir, '.bashrc'), 'utf8');

  const result = runTeardown(directories, ['--shell', 'bash', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry run/i);
  assert.equal(readFileSync(join(directories.homeDir, '.bashrc'), 'utf8'), installed);
  assert.ok(existsSync(join(directories.configHome, 'pi-presets', 'pi.sh')));
});

test('teardown rejects unknown options and unsupported shells', (t) => {
  const directories = makeDirectories(t);

  assert.equal(runTeardown(directories, ['--force']).status, 2);
  assert.equal(runTeardown(directories, ['--shell']).status, 2);
  const unsupported = runTeardown(directories, ['--shell', 'nu']);
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /unsupported shell/i);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/setup.test.ts`
Expected: FAIL，`src/teardown.ts` 不存在（spawn 后 status 非 0）。

- [ ] **Step 3: 实现入口**

`src/teardown.ts` 结构与 `src/setup.ts` 对齐：自有 `TeardownUsageError`、解析 `--shell <value>`（可缺省，缺省为 `SUPPORTED_SHELLS` 全部）与 `--dry-run`，调用 `removeShellIntegration`，按 `files` / `rcFiles` / `keptFiles` 打印结果；三者皆空时打印 `Nothing to remove: no pi-presets shell integration found.`；用法错误 `process.exitCode = 2`，其它错误 1。`package.json` 的 `scripts` 增加 `"teardown": "node src/teardown.ts"`。

- [ ] **Step 4: 跑全量测试与类型检查**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS，typecheck 无输出。

- [ ] **Step 5: 提交**

```bash
git add src/teardown.ts test/setup.test.ts package.json
git commit -m "feat: add teardown command to undo shell integration"
```

---

### Task 5: 文档

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 3、Task 4 确定的命令形式。

- [ ] **Step 1: 更新 README**

在「Setup」小节后补三部分：

1. `--dry-run`：说明它不写盘，stdout 只有可 eval 的代码；给出 bash/zsh 的 `eval "$(npm run --silent setup -- --dry-run)"` 与 fish 的 `eval (npm run --silent setup -- --dry-run | string collect)`（fish 的 `(...)` 用空格拼接多行，缺 `string collect` 时首行注释会吃掉整段代码）；点明必须 `--silent`，以及 `$SHELL` 猜错时用 `--shell`。
2. 卸载：`npm run teardown`、`npm run teardown -- --shell bash`、`npm run teardown -- --dry-run`；说明幂等、只删自己的标记与生成文件、zsh 仍注册时保留共享函数文件。
3. 目录搬家：说明函数里烘焙了仓库绝对路径，移动后需在新位置重跑 `npm run setup`，旧函数文件会被就地改写，rc 不变（不必编辑 rc）。

- [ ] **Step 2: 校对命令与实际行为**

Run: `npm run setup -- --dry-run --shell bash | head -3` 与 `npm run teardown -- --dry-run`
Expected: 前者输出函数定义、`$HOME` 无新文件；后者报告 nothing to remove 或删除计划，退出码 0。任一不符则回头修 README 或代码。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: document setup --dry-run, teardown and repo relocation"
```
