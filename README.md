# pi-presets

把本仓库中的 Pi package 目录注册为简短的 preset 名称，按需通过 `-e` 加载，不修改 Pi 的全局 package 配置。

## Setup

```sh
git clone https://github.com/yandy/pi-presets.git /path/to/somewhere
cd /path/to/somewhere
npm install
npm run setup
exec "$SHELL"
```

`npm install` 会在各个 preset 自己的目录中安装依赖。`setup` 默认根据 `$SHELL` 安装 shell function，目前支持交互式 fish、bash 和 zsh。也可以显式指定 shell：

```sh
npm run setup -- --shell fish # 或 bash、zsh
```

重复执行 `setup` 不会重复写入 shell 配置。

### 只作用于当前 shell（不落盘）

`--dry-run` 不写任何文件，只把可 `eval` 的 shell 代码打到 stdout，人类可读说明全部走 stderr：

```sh
# bash / zsh
eval "$(npm run --silent setup -- --dry-run)"

# fish
eval (npm run --silent setup -- --dry-run | string collect)
```

执行后当前 shell 立刻有 `pi`，关掉即消失，磁盘上不留任何东西。两处细节都是必需的：

- `--silent`：否则 npm 自己的横幅会进 stdout，被一并 `eval`。
- fish 的 `(...)` 会把多行输出按空格拼成一行，而函数代码的第一行是注释，会把后面全部吃掉；`| string collect` 让整段代码保持为单个元素。`string collect` 需要 fish 3.1 或更新版本。

默认按 `$SHELL`（登录 shell）选择目标；在 bash 里嵌套 fish 之类的情况下用 `--shell` 指定：

```sh
eval "$(npm run --silent setup -- --dry-run --shell bash)"
```

直接执行 `npm run setup -- --dry-run`（stdout 是终端）时，代码照常打印在屏幕上，另附一行 `eval` 用法提示。

### 卸载

```sh
npm run teardown                    # 清理 fish、bash、zsh 全部注册
npm run teardown -- --shell bash    # 只清理 bash
npm run teardown -- --dry-run       # 只打印将删除/将剥离的清单
```

卸载只动自己写下的东西：从 `.bashrc`/`.zshrc` 摘掉受管标记块，删除 `$XDG_CONFIG_HOME/pi-presets/pi.sh` 与 `fish/conf.d/pi-presets.fish`，标记块之外的配置一个字节都不改。重复执行是空操作（退出码 0）；标记块被手工改残（少了开始或结束标记，或出现重复标记）时整体中止、不修改任何文件。一个已知例外：rc 原本没有末尾换行时，安装会补上一个，卸载后保留这个换行——不推断原状态，也不为了恢复它去猜。`pi.sh` 由 bash 与 zsh 共用，所以 `--shell bash` 在 zsh 仍注册着时会保留它，并在输出中说明。

### 移动仓库目录

生成的 shell function 里烘焙了仓库的绝对路径（`<repo>/src/cli.ts`），所以搬动目录后旧 function 会立刻失效。在新位置重跑一次即可：

```sh
cd /new/path/to/pi-presets
npm run setup
exec "$SHELL"
```

函数文件会被就地改写成新路径，rc 文件不变（不需要手工编辑 rc）。反过来的注意点：如果你在旧克隆里又跑了一次 `setup`，注册会指回旧路径——同一时间只有最后一次 `setup` 生效。

## 使用方法

```sh
cd /path/to/your/workspace

# 传递参数 -ps/--preset <preset1>[,<preset2>] 加载1个或多个 preset
# 其他参数透传 pi

# 示例
# 加载 coding preset, 进入交互 TUI
pi -ps coding
# 加载 coding和office 2个preset, 进入交互 TUI
pi -ps coding,office # 加载 coding, office preset
# 加载 coding preset, 非交互模式执行一个prompt
pi -ps coding -p "List all .ts files in src/"
```

每个 preset 都会展开为对应 package 的一次 `-e` 加载。例如，上面的命令等价于：

```sh
pi -e /path/to/somewhere/coding
pi -e /path/to/somewhere/coding -e /path/to/somewhere/office
```

也支持 `--preset coding`、`--preset=coding,office` 和重复使用 preset 参数。除 preset 参数外，其他参数、stdin/stdout、当前工作目录和 Pi 退出码均保持原样。

未知的 preset 会在启动 Pi 前报错并列出可用名称。shell function 只在加载了对应配置的交互式 shell 中生效；独立脚本、未加载配置的子 shell 或其他程序直接启动 `pi` 时，请继续使用完整的 `pi -e /path/to/preset` 形式。

## 开发

实现和测试使用 TypeScript。Node 22.19 或更新版本直接运行可擦除的 `.ts` 语法，无需构建步骤；相对导入需要显式使用 `.ts` 后缀。

```sh
npm run typecheck
npm test
```
