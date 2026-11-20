# Pi Preset CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在交互式 fish/bash/zsh 中提供 `pi -ps/--preset`，将 preset 名称展开为本仓库 package 的 `-e` 参数，同时完整保留普通 Pi 行为。

**Architecture:** shell function 只负责调用仓库内 Node 包装器；包装器完成参数展开、真实 Pi 查找和进程透传。setup 生成幂等的 shell 集成，根安装脚本分别为各 preset 安装本地依赖，避免 npm 提升依赖后破坏 package 资源路径。

**Tech Stack:** Node.js 22.19+ ESM、Node 内置 `node:test`、fish/bash/zsh、npm。

**Spec:** `docs/superpowers/specs/2026-11-20-preset-cli-design.md`

## Global Constraints

- 每个 preset 名称只映射为仓库直接子目录中的 package，并展开为一次 `-e <绝对路径>`。
- 支持 fish、bash、zsh 的交互式 shell；独立脚本和直接 `exec pi` 不在支持范围内。
- 非 preset 参数、cwd、stdin/stdout/stderr 和真实 Pi 退出状态必须透传。
- 用法错误退出码为 2；不修改原始 Pi 安装、Pi settings 或凭据。
- setup 幂等，仓库路径包含空格时仍须工作。
- 不使用 npm workspaces，不增加运行时或测试框架依赖。

## Review Focus

- `--` 后的 `-ps` 是 prompt 而非选项，逗号空项与路径穿越必须拒绝；Task 1 的边界测试固定这些行为。
- PATH 中没有真实 `pi`、存在不可执行项或同名目录时应清晰失败；Task 2 用 PATH fixture 验证。
- 子进程非零退出和 SIGTERM 不得被包装器吞掉；Task 2 的进程测试验证退出码与信号转发。
- 仓库路径含空格、shell 配置已有内容或重复 setup 时不得错引路径/重复追写；Task 3 的烟雾与幂等测试覆盖。
- preset manifest 损坏或 npm 安装失败时应指出具体 preset 并非零退出；Task 4 测试失败传播。

---

### Task 1: Preset 参数展开核心

**Files:**
- Create: `package.json`
- Create: `src/presets.js`
- Create: `test/presets.test.js`

**Interfaces:**
- Produces: `expandPresetArgs(args: readonly string[], presetsRoot: string): string[]`。
- Produces: `listPresets(presetsRoot: string): string[]`，返回排序后的可用 preset 名称。
- Produces: `PresetUsageError extends Error`，供 CLI 映射为退出码 2。

- [ ] **Step 1: 写失败的参数展开测试**

用临时目录建立 `coding/`、`office/`（各含 `package.json`）及一个无 manifest 的目录。测试以下精确行为：

```js
assert.deepEqual(
  expandPresetArgs(['-ps', 'coding', '-p', 'hello'], root),
  ['-e', join(root, 'coding'), '-p', 'hello']
);
assert.deepEqual(
  expandPresetArgs(['--preset', 'coding, office', '--preset=office', '--', '-ps', 'coding'], root),
  ['-e', join(root, 'coding'), '-e', join(root, 'office'), '-e', join(root, 'office'), '--', '-ps', 'coding']
);
```

另测无 preset 时 argv 不变、重复名称不去重、参数顺序不变；缺失值、`coding,,office`、空字符串、`.`、`..`、含 `/` 或 `\\` 的名称、未知 preset、无 manifest 目录均抛 `PresetUsageError`，未知名称错误包含 `listPresets()` 返回的可用名称。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/presets.test.js`
Expected: FAIL，原因是 `src/presets.js` 尚不存在。

- [ ] **Step 3: 实现最小 ESM package 与参数展开**

`package.json` 先声明私有 package、`"type": "module"`、`"engines": {"node": ">=22.19"}` 和 `"test": "node --test"`。

在 `src/presets.js` 中仅在第一个 `--` 前识别 `-ps <value>`、`--preset <value>`、`--preset=<value>`。名称按逗号拆分并 trim，以 `^[A-Za-z0-9._-]+$` 校验后排除 `.`/`..`；解析完成后检查目录与 `package.json`。在原参数位置展开，其余 argv 不解释、不重排。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node --test test/presets.test.js`
Expected: 所有测试 PASS。

- [ ] **Step 5: 提交独立核心改动**

```bash
git add package.json src/presets.js test/presets.test.js docs/superpowers/specs/2026-11-20-preset-cli-design.md docs/superpowers/plans/2026-11-20-preset-cli.md
git commit -m "feat: add preset argument expansion"
```

### Task 2: 真实 Pi 进程包装器

**Files:**
- Create: `src/cli.js`
- Create: `test/cli.test.js`
- Test: `test/presets.test.js`

**Interfaces:**
- Consumes: Task 1 的 `expandPresetArgs()`、`PresetUsageError`。
- Produces: 可执行入口 `node src/cli.js [args...]`；仓库根由 `import.meta.url` 推导，与调用 cwd 无关。

- [ ] **Step 1: 写失败的 CLI 集成测试**

测试 helper 在临时 bin 目录生成带 `process.execPath` shebang 的假 `pi`，由它记录 argv/cwd/stdin 并可控地写 stdout/stderr、退出或处理信号。通过仅含假 bin 的 PATH 调用真实 `src/cli.js`，覆盖：

- `coding` 展开后的 argv 与调用者 cwd 完全一致，stdin/stdout/stderr 原样传输。
- 无 preset 的参数（含 `--`）逐项不变。
- 假 Pi 退出 23 时包装器状态也是 23。
- 假 Pi 就绪后向包装器发送 SIGTERM，假 Pi 收到该信号并以 42 退出，包装器返回 42。
- PATH 无可用 Pi 时退出非零且 stderr 指明找不到 Pi；用法错误退出 2 且不会启动假 Pi。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/cli.test.js`
Expected: FAIL，原因是 `src/cli.js` 尚不存在。

- [ ] **Step 3: 实现进程查找、透传与信号处理**

`src/cli.js` 从 PATH 顺序查找第一个可执行的普通文件/符号链接 `pi`，跳过目录和不可执行项。使用 `spawn(realPi, expandedArgs, {stdio: 'inherit', cwd, env, shell: false})`；转发 SIGINT、SIGTERM、SIGHUP，子进程以信号结束时映射为常规 `128 + signalNumber`，启动错误返回 1。捕获 `PresetUsageError` 返回 2，其余错误返回 1 并输出简洁错误。

- [ ] **Step 4: 运行核心与 CLI 测试**

Run: `node --test test/presets.test.js test/cli.test.js`
Expected: 所有测试 PASS，且测试未访问真实 Pi 配置。

- [ ] **Step 5: 提交进程包装器**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat: forward preset invocations to pi"
```

### Task 3: fish/bash/zsh setup

**Files:**
- Create: `src/shell-integration.js`
- Create: `src/setup.js`
- Create: `test/setup.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `installShellIntegration({shell: 'fish'|'bash'|'zsh', repoRoot: string, homeDir: string, configHome: string}): {files: string[]}`。
- Produces: CLI `node src/setup.js [--shell fish|bash|zsh]`；未显式指定时取 `$SHELL` 的 basename。
- Consumes: Task 2 的 `src/cli.js`，生成函数通过绝对路径调用它。

- [ ] **Step 1: 写失败的 setup 与 shell function 测试**

在临时 HOME/config 目录调用 `installShellIntegration()`，验证：

- fish 写入 `<configHome>/fish/conf.d/pi-presets.fish`。
- bash/zsh 写入 `<configHome>/pi-presets/pi.sh`，并分别在 `<homeDir>/.bashrc`、`.zshrc` 添加 `# >>> pi-presets >>>` / `# <<< pi-presets <<<` 受管 source 块。
- 已有 rc 前后内容保持不变；连续安装两次后标记和 source 行各只出现一次；不完整的旧受管块应报错而不是删除用户内容。
- setup 默认识别 `$SHELL`，显式 `--shell` 覆盖它；不支持的 shell/缺失参数退出 2。
- 对系统存在的 shell 做 function 烟雾测试：把完整 `src/` 和 `coding` fixture 复制到含空格的临时 repo 路径，source 生成文件后执行 `pi -ps coding -p hello`，由假 Pi 验证展开参数。zsh 未安装时仅跳过 zsh 烟雾测试，fish/bash 语法检查仍按可用性执行。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/setup.test.js`
Expected: FAIL，原因是 shell integration 模块尚不存在。

- [ ] **Step 3: 实现 shell 代码生成与幂等安装**

生成的 function 始终用 shell 对应的 argv 语法执行 `command node <quoted src/cli.js> <args>`，真实 Pi 查找仍交给 Node。为单引号、空格和 shell 元字符做正确转义。

`configHome` 由调用者传入；CLI 默认使用 `$XDG_CONFIG_HOME` 或 `<homeDir>/.config`。fish 直接重写生成文件；bash/zsh 只替换完整受管块，遇到不成对标记则停止。根 `package.json` 增加 `"setup": "node src/setup.js"`。成功输出包含当前 shell 可用的 `exec "$SHELL"` 提示，显式安装其他 shell 时输出对应 source/重启提示。

- [ ] **Step 4: 运行 setup 测试及全套回归**

Run: `node --test test/setup.test.js && npm test`
Expected: 所有测试 PASS；重复 setup fixture 不产生重复配置。

- [ ] **Step 5: 提交 shell 集成**

```bash
git add package.json src/shell-integration.js src/setup.js test/setup.test.js
git commit -m "feat: install preset shell integration"
```

### Task 4: Preset 依赖安装、office 占位与使用文档

**Files:**
- Create: `src/install-presets.js`
- Create: `test/install-presets.test.js`
- Create: `office/package.json`
- Create: `package-lock.json`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces: `installPresetDependencies({repoRoot: string, runner?: Function}): Promise<string[]>`，返回实际安装依赖的 preset 名称。
- Produces: 根 `npm install` 的 `postinstall` 自动调用安装器；`runner` 仅用于测试注入。
- Consumes: 各直接子目录的 `package.json` 和可选 `package-lock.json`。

- [ ] **Step 1: 写失败的依赖安装测试**

用临时 preset tree 和记录型异步 runner 验证：

- 有 dependencies/devDependencies/optionalDependencies 且有 lockfile 时执行 `npm ci`，无 lockfile 时执行 `npm install`，cwd 必须是该 preset 目录。
- 无依赖 package、无 manifest 目录和 `node_modules` 不执行 npm；返回名称按扫描结果排序。
- 非法 JSON manifest 和 runner 拒绝均向上传播，错误包含 preset 名称。
- `office/package.json` 是无资源、无依赖的合法私有 Pi package，README 中的 `coding,office` 两个名称都可由 `listPresets()` 找到。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/install-presets.test.js`
Expected: FAIL，原因是安装器与 office manifest 尚不存在。

- [ ] **Step 3: 实现独立依赖安装与 package 配置**

安装器只扫描根目录直接子项，在任何 dependencies/devDependencies/optionalDependencies 非空时运行相应 npm 命令，默认 runner 使用继承 stdio 的子进程并以非零退出拒绝。根 `package.json` 增加 `"postinstall": "node src/install-presets.js"`；增加无依赖的 `office/package.json`，不创建 npm workspace。

更新 README：保留用户给出的三条调用示例，补充 `exec "$SHELL"`、`npm run setup -- --shell <fish|bash|zsh>`、参数展开规则、交互式 shell 限制、普通参数透传和未知 preset 报错。

- [ ] **Step 4: 生成根 lockfile 并验证真实安装路径**

Run: `npm install --package-lock-only --ignore-scripts && npm install`
Expected: 根 lockfile 生成；postinstall 在 `coding/` 内安装依赖，不清空或替代原 package 资源路径，`coding/node_modules/superpowers` 存在。

- [ ] **Step 5: 运行完整验证**

Run: `npm test && git diff --check && git status --short`
Expected: 全部测试 PASS，无 whitespace 错误；status 只显示本任务预期文件及用户原有但尚未提交的改动（若有）。

- [ ] **Step 6: 提交安装与文档改动**

```bash
git add package.json package-lock.json src/install-presets.js test/install-presets.test.js office/package.json README.md
git commit -m "feat: complete preset setup workflow"
```
