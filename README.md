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
