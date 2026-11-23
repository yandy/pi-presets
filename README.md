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

### 只在当前 shell 生效（不落盘）

```sh
# bash / zsh
eval "$(npm run --silent setup -- --dry-run)"

# fish（需 fish 3.1+）
eval (npm run --silent setup -- --dry-run | string collect)
```

执行后当前 shell 有 `pi`，关掉即消失，磁盘上不留东西。命令里的 `--silent` 和 fish 的 `| string collect` 都不能省。

### 卸载

```sh
npm run teardown                    # 清理全部注册
npm run teardown -- --shell bash    # 只清理 bash
npm run teardown -- --dry-run       # 只打印将删除的内容
```

只动 `setup` 写下的标记块和函数文件。重复执行是空操作；标记块被手工改坏时整体中止，不改任何文件。

### 移动仓库目录

函数里记的是仓库的绝对路径，搬目录后重跑一次：

```sh
cd /new/path/to/pi-presets
npm run setup
exec "$SHELL"
```

`rc` 不用改。

### 提示：给常用的 preset 配简写

`setup` 结束时会给出一段示例，可以直接粘贴到 shell 里，也可以写进自己的配置文件长期生效：

```fish
# fish：abbr（输入时展开，可用 `abbr -e picode` 删除）
abbr --add picode 'pi -ps coding'
abbr --add piwork 'pi -ps office,design'
```

```sh
# bash / zsh：alias
alias picode='pi -ps coding'
alias piwork='pi -ps office,design'
```

简写只是省去输入，等价于完整写法，不影响参数透传：`picode -p "list ts files"` 等于 `pi -ps coding -p "list ts files"`。

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

行为契约与设计取舍见 `docs/superpowers/specs/`。
