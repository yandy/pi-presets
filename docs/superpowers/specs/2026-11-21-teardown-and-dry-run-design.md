# setup 卸载与 dry-run 设计

## 意图

让 shell 集成的生命周期完整：装得上、看得见、退得掉。今天 `npm run setup` 只会写、不会删，仓库换位置后旧注册既无法清理也无法探测。同时提供「只在当前 shell 生效一次、完全不落盘」的用法。

## 目标

- `npm run setup -- --dry-run [--shell X]` 不写任何文件，stdout 输出可 `eval` 的 shell 代码。
- `npm run teardown [-- --shell X] [--dry-run]` 撤销集成：摘掉受管标记块、删除生成文件。
- teardown 幂等：没装过是空操作，退出码 0。
- 已有 `setup` 行为的可观察结果不变（文件路径、块格式、幂等性）。

## 非目标与反目标

- 不做多仓库注册：仍然是「最后一次 setup 的注册生效」。
- 不改 `pi` 包装器（`src/cli.ts`）的运行期行为。
- 不清理已经加载到内存里的 shell function：那是 shell 语义，进程退出即消失。
- 不支持 Windows/PowerShell。
- 不删除 `conf.d`、`pi-presets` 之外的任何目录，不触碰用户配置中的非受管内容。

## 约束

- `setup` / `teardown` 都是子进程，无法修改父 shell。因此「只改当前 shell」唯一形态是输出代码、由父 shell `eval`。
- 必须配 `npm run --silent`，否则 npm 自己的横幅会被一并 `eval`。
- `$SHELL` 是登录 shell；在 bash 里嵌套 fish 时会猜错，`--shell` 是唯一兜底。
- bash 与 zsh 共用一个 `$XDG_CONFIG_HOME/pi-presets/pi.sh`，函数内容两者本来相同。
- 仓库可被克隆到含空格、引号、`$` 的路径，生成的 shell 代码必须正确引用。

## 方案比较

### 1. `--dry-run` 输出可 eval 代码，teardown 作为独立入口（已选择）

`--dry-run` 复用渲染函数，stdout 只放 shell 代码，人类说明全部走 stderr；`--shell` 可选，缺省取 `$SHELL`。teardown 放在 `src/teardown.ts`，与 `setup.ts` 平级，共享 `src/shell-integration.ts` 的渲染与标记逻辑。

优点：`--dry-run` 输出与真正安装逐字节一致，因此「eval 能用的代码」和「将来会写下的文件」不可能分叉；teardown 不污染 `setup` 的参数语义。代价：多一个入口文件。

### 2. 单一入口 `setup --uninstall`

少一个文件、少一个 npm script，但 `setup --uninstall` 读起来自相矛盾，且 `setup` 的参数解析要同时容纳安装与卸载两组选项。放弃。

### 3. `--once` 基于「安装后自动注销」的实现

做不到：子进程无法在父 shell 里安排退出时的清理。放弃。

## 实现组成

### `src/shell-integration.ts` 新增导出

- `renderFunctionSource(shell, repoRoot): string`：当前 `renderFunction` 的公开形态，`setup` 与 `--dry-run` 共用，保证代码与文件同源。
- `shellIntegrationPaths(shell, homeDir, configHome): string[]`：只算路径不写盘，`installShellIntegration` 改为复用它，`--dry-run` 用它打印「将要写入」清单。
- `removeShellIntegration({ shells, homeDir, configHome, dryRun? }): RemovalResult`：执行删除或返回删除计划。`RemovalResult` 含 `files`（已删除/将删除）、`rcFiles`（已剥离/将剥离）、`keptFiles`（有意保留，例如另一个 posix shell 仍在引用的 `pi.sh`）。

### 卸载语义

- 标记块剥离：读取 rc，定位 `# >>> pi-presets >>>` 与 `# <<< pi-presets <<<` 之间的片段并移除；同时吞掉紧邻块一侧多余的一个换行（安装时追加会在块前加一个空行、块后加一个换行）。标记块外的字节不得改变：对于原本以换行结尾的 rc，`install` 后 `remove` 逐字节回到安装前内容。
- 末尾换行规范化（已知且已接受的例外）：rc 原本**没有**末尾换行时，安装补一个换行，卸载后保留它。`install` 对 `foo` 与 `foo\n` 产生相同结果，因此无法反推原状，本设计选择不猜。
- 标记只出现一半、顺序错乱或出现重复标记：与 `install` 一致地报 `Incomplete managed block`，退出码 1。此时先校验全部 rc，任何一个不合法就整体不修改。重复标记必须中止而不是取第一对：畸形 rc 中两个开始标记之间的内容可能就是用户配置，猜错等于删配置。
- 剥离后 rc 内容为空字符串时保留该空文件，不删除。空的 rc 与不存在的 rc 在 shell 语义上等价，但删除用户的 dotfile 比留一个空文件更糟。
- `pi.sh` 删除条件：处理后**没有任何** rc 文件仍含受管标记块。因此 `teardown --shell bash` 在 zsh 还注册着时会保留 `pi.sh`，并在输出中说明；`pi-presets` 目录为空时 `rmdir`。
- fish：删除 `conf.d/pi-presets.fish`，不动 `conf.d` 目录本身。

### `--dry-run` 语义（setup）

- 不写任何文件，也不创建 `$XDG_CONFIG_HOME/pi-presets` 目录。
- stdout 恰好是函数文件内容，无其他字节；stderr 输出「dry run：不会写盘」与「将写入：<路径列表>」。
- stdout 是 TTY 时（人肉直接执行）额外向 stderr 打印 eval 用法；stdout 仍是代码，保证既能阅读也能 eval。
- fish 的用法必须带 `| string collect`：fish 的 `(...)` 把多行输出按空格拼成一行，而函数代码第一行是注释，会把后面整段吃掉。bash/zsh 用 `eval "$(...)"`。

### 入口与脚本

- `npm run setup -- --dry-run`（`setup.ts` 新增 `--dry-run`，与 `--shell` 可组合）。
- `npm run teardown [-- --shell X] [--dry-run]`。命名为 `teardown` 而非 `uninstall`，避免与 npm 的 `uninstall` 生命周期事件同名。
- 用法错误（未知选项、`--shell` 缺值或不支持）退出码 2，与现状一致。

## 验证

- 单元测试：`renderFunctionSource` 与安装产物逐字节相等；`shellIntegrationPaths` 与 `installShellIntegration().files` 相同。
- 往返不变量：`install → remove` 后 rc 逐字节等于安装前；`install → install → remove` 同样；`remove → install` 与单次 `install` 逐字节相同。
- 边界：不存在/空 rc；块后有用户内容；标记不完整（整体中止）；`teardown --shell bash` 时 zsh 仍注册（`pi.sh` 保留）；fish 与 posix 并存。
- dry-run：退出码 0，stdout 精确等于函数文件内容，`$HOME` 与 `$XDG_CONFIG_HOME` 下不新增任何文件；在真实 bash 与 fish 中 `eval` 该输出后用假 `pi` 验证 argv 与安装版一致（fish 必须用 `string collect` 形式）。
- 幂等：重复 teardown 第二次为空操作，退出码 0。

## 留给实现者的细节

标记块剥离时换行吞噬的具体实现、`RemovalResult` 中 `keptFiles` 的判定代码组织、`src/teardown.ts` 的参数解析写法、错误与提示文案、测试 helper 命名。这些不改变上述外部行为。
