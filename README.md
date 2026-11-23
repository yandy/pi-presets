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

支持的 shell 随平台不同：Linux/macOS 上是 fish、bash、zsh，Windows 上只有 `powershell`。

### Windows（PowerShell）

Windows 上不用指定 shell，`setup` 默认就装 PowerShell：

```powershell
git clone https://github.com/yandy/pi-presets.git C:\path\to\somewhere
cd C:\path\to\somewhere
npm install
npm run setup
```

`setup` 先找出本机装了哪些 PowerShell 宿主（先 `pwsh.exe`，再 `powershell.exe`），逐个问出各自的 `$PROFILE`，再把同一个受管块写进所有这些 profile：PowerShell 7 与 Windows PowerShell 5.1 因此各有一份 `pi` function。装完重启 PowerShell，或在其中执行：

```powershell
. $PROFILE
```

`--shell powershell` 可以显式指定（等于 Windows 上的默认值），但只在 Windows 上有效，其他平台报错并以退出码 2 结束：

```console
$ npm run setup -- --shell powershell
pi-presets setup: Unsupported shell: powershell. PowerShell is not supported on this platform. Choose fish, bash, or zsh.
```

一个宿主都没找到时 `setup` 报错退出（退出码 1）并列出找过的位置；找到了却问不出 `$PROFILE` 时整次安装中止，一个文件都不写。profile 的编码限制见「已知限制（Windows）」。

### 只在当前 shell 生效（不落盘）

```sh
# bash / zsh
eval "$(npm run --silent setup -- --dry-run)"

# fish（需 fish 3.1+）
eval (npm run --silent setup -- --dry-run | string collect)
```

```powershell
# PowerShell：先摆好编码，再吃下 stdout
[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8
Invoke-Expression (& npm.cmd run --silent setup -- --dry-run --shell powershell | Out-String)
```

执行后当前 shell 有 `pi`，关掉即消失，磁盘上不留东西。命令里的 `--silent` 和 fish 的 `| string collect` 都不能省。PowerShell 的 stdout 只有函数定义本身（`--dry-run` 的提示都走 stderr），所以 `Out-String` 不能省；第一行的编码设置也不能省，否则 Node 写出的 UTF-8 字节会按当前代码页解码，仓库路径含非 ASCII 字符时函数里的路径会乱码。

### 卸载

```sh
npm run teardown                    # 清理全部注册
npm run teardown -- --shell bash    # 只清理 bash
npm run teardown -- --dry-run       # 只打印将删除的内容
```

只动 `setup` 写下的标记块和函数文件。重复执行是空操作；标记块被手工改坏时整体中止，不改任何文件。

Windows 上 `npm run teardown` 会剥离 PowerShell 7 与 5.1 两个 profile 里的受管块：宿主报告的路径，加上 `%USERPROFILE%\Documents\…` 和 `%OneDrive%\Documents\…` 下的默认位置（只动真含标记块的文件）。某个宿主查不出自己的 `$PROFILE` 时不阻断卸载，`teardown` 会在 stderr 说明并退回默认路径扫描，仍退出 0。`--shell powershell` 同样只在 Windows 上有效。

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

```powershell
# PowerShell：函数（Set-Alias 不能带参数，所以用 function）
function picode { pi -ps coding @args }
function piwork { pi -ps office,design @args }
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

## 已知限制（Windows）

- **`%VAR%` 和 `!` 会被 cmd 改写。** npm 装出来的 `pi` 是 `pi.cmd`，Node 只能经 `cmd.exe` 启动它，cmd 会展开参数里的 `%VAR%`，在启用延迟展开的场合还会吃掉 `!`。这两个字符没有既安全又不破坏内容的转义写法，只能原样传下去。
- **5.1 与 7 的传参规则不同。** Windows PowerShell 5.1 用 `Legacy` 规则，PowerShell 7.3+ 在 Windows 上默认 `Standard`（`$PSNativeCommandArgumentPassing`），含内嵌引号或以 `\` 结尾的参数在 5.1 上会走样。包装函数不设这个变量：它在 5.1 上不存在，设了也没用。
- **UTF-16 的 profile 会被拒绝。** profile 若被另存为 UTF-16（5.1 的 `>` 和 `Out-File` 默认就是），`setup` 与 `teardown` 都不处理，报 `looks like a UTF-16 encoded file; save it as UTF-8 and run setup again.` 并以退出码 1 结束，一个文件都不改，请先另存为 UTF-8。新建的 profile 写 UTF-8 BOM，已有 BOM 原样保留；本来没有 BOM、实际是 ANSI 编码的 profile 按 UTF-8 处理，其中的非 ASCII 内容会被写坏。
- **`Set-Alias pi` 会遮蔽包装函数。** 别名优先级高于函数，自己设过 `Set-Alias pi …` 的话 `pi -ps coding` 不会走到包装函数，preset 也就不会展开；先 `Remove-Item Alias:pi`。
- **自定义位置的 profile 扫不到。** 安装只写宿主自己报告的 `$PROFILE`（`Microsoft.PowerShell_profile.ps1`），不写 `profile.ps1`（AllHosts）；卸载多扫 `%USERPROFILE%\Documents\…` 与 `%OneDrive%\Documents\…` 下的默认位置，宿主不报告、你另设在别处的 profile 不在其中。
- **真实冒烟需要一台 Windows。** 本机（Linux）跑不了：要在 PowerShell 7 与 Windows PowerShell 5.1 里各跑一遍 `pi -ps coding`、`pi -ps coding -p "list ts files"`，再跑 `npm run teardown` 确认 profile 逐字节还原。

## 开发

实现和测试使用 TypeScript。Node 22.19 或更新版本直接运行可擦除的 `.ts` 语法，无需构建步骤；相对导入需要显式使用 `.ts` 后缀。

```sh
npm run typecheck
npm test
```

Windows 专属路径在 Linux 上没法真的跑，测试用 `PI_PRESETS_PLATFORM=win32` 覆盖平台判断。

行为契约与设计取舍见 `docs/superpowers/specs/`。
