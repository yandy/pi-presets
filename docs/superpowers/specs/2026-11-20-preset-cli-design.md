# Pi preset 命令入口设计

## 意图

让使用者在任意工作目录中，把冗长的：

```sh
pi -e /path/to/pi-presets/coding
```

简化为：

```sh
pi -ps coding
pi --preset coding
pi -ps coding,office -p "List all .ts files in src/"
```

preset 只是 Pi package 的命名快捷方式，不引入另一套资源配置机制。每个名称都解析为本仓库下的同名目录，并展开成一次 `-e <绝对路径>`；Pi 仍负责实际加载 extensions、skills、prompts 和 themes。

## 目标

- `npm install && npm run setup` 安装命令入口和各 preset 的本地依赖。
- 在 fish、bash、zsh 中提供 `pi -ps/--preset`。
- 支持逗号分隔的多个 preset，也支持重复使用 preset 参数。
- 非 preset 参数、当前工作目录、stdin/stdout/stderr、交互模式和退出状态保持不变。
- setup 幂等；重复执行不会叠加 shell 配置。
- 不修改原始 Pi 安装，不写入 Pi 的全局 package 配置。

## 非目标与反目标

- 不实现 preset 资源的合并、过滤或优先级系统。
- 不设计 office preset 的具体工具内容；只提供空 package 占位，使 README 示例有效。
- 不支持 Windows/PowerShell。
- 只保证已加载 shell 配置的交互式 fish/bash/zsh；独立脚本、未加载配置的子 shell 和其他程序直接 `exec pi` 仍使用原始 `pi -e /absolute/path`。README 中由交互式 shell 启动的 `pi -p` 单次执行在支持范围内。
- 不读取或改写凭据、`~/.pi/agent/settings.json` 或会话文件。
- 不替换 npm 全局 `pi` 链接，不要求 preset 永久加载到每次 Pi 调用中。
- 不让包装器改变普通 `pi ...` 调用的行为。

## 约束

- Pi 本地 `-e` package 不会被 Pi 自动安装依赖，所以每个 preset 必须保留自己的 `node_modules`。
- 不使用 npm workspaces 向上提升依赖，避免 `coding/node_modules/...` 的 package manifest 路径失效。
- 仓库可以被克隆到包含空格的任意路径；生成的 shell 代码必须正确引用路径。
- setup 是子进程，无法修改其父 shell。安装后需要重开终端，或执行 README 给出的 `exec "$SHELL"`。
- Node.js 版本要求与 Pi 一致：22.19 或更新版本。

## 方案比较

### 1. Shell function（已选择）

setup 安装名为 `pi` 的轻量函数，函数调用本仓库的 Node 包装器。包装器从 PATH 查找真实的外部 `pi` 可执行文件，因此不会递归调用 shell function，也不需要保存 fnm 的临时路径。

优点：不侵入 Pi 原安装，不依赖 PATH 中 shim 的优先级，容易幂等更新和测试。代价：需要 shell 配置和一次 shell 重载。

### 2. PATH shim

在 `~/.local/bin/pi` 放置包装器并调整 PATH。优点是不依赖 shell function；缺点是必须处理 PATH 顺序和递归查找，对现有 fnm 多路径环境更脆弱。

### 3. 替换全局 Pi 链接

直接改 npm 全局 bin 中的 `pi`。看似直接，但 Pi 升级、Node 版本切换或重装会覆盖它，且对原安装侵入性太强，因此不采用。

## 实现组成

### 根 package 与 preset 依赖安装

根目录新增私有 `package.json`，提供 `setup` 和 `test` 脚本。`postinstall` 扫描根目录的直接子目录：对含有 `package.json` 且声明依赖的 preset，在其自身目录执行 `npm ci`（存在 lockfile）或 `npm install`，从而保留各 preset 独立的依赖树。

`office/` 增加不含资源与依赖的最小 package manifest，作为可加载的空 preset。

### Node 包装器

包装器接收原始 argv，并执行以下步骤：

1. 在第一个 `--` 之前识别 `-ps <value>`、`--preset <value>` 和 `--preset=<value>`；`--` 之后的内容一律视为 Pi 参数或 prompt。
2. 按逗号拆分并 trim 名称，保持出现顺序。名称只允许字母、数字、点、下划线和连字符，且不能是 `.` 或 `..`；空名称、路径分隔符和缺失参数属于用法错误。
3. 验证每个名称对应仓库直接子目录中的 package（目录和 `package.json` 均存在）。未知 preset 在启动 Pi 前报错，并列出可用名称。
4. 将每个参数出现位置替换为一组 `-e <preset 绝对路径>`，其余参数逐项原样保留。重复名称不自行去重，最终语义交由 Pi 决定。
5. 没有 preset 参数时走完全相同的透传路径，不注入 `-e`。
6. 从当前 PATH 选择第一个可执行的外部 `pi`，以继承的 stdio 和当前 cwd 启动它。转发终止信号，并映射子进程退出码或信号退出状态；启动失败返回非零并给出清晰错误。

用法错误退出码为 2，真实 Pi 的退出码原样返回。

### Shell 集成与 setup

setup 默认根据 `$SHELL` 选择 fish、bash 或 zsh，也接受显式 shell 选项以便安装到指定 shell。

- fish：在 fish 的 `conf.d` 中写入 `pi-presets.fish`。
- bash/zsh：在用户配置目录生成公共 function 文件，并在 `.bashrc`/`.zshrc` 的受管标记块中加入 source 命令。

所有函数仅调用 `node <仓库内包装器绝对路径> "$@"`（使用相应 shell 的等价语法），真实 Pi 的查找统一由 Node 包装器完成。setup 重写同名生成文件并替换受管块，因此可重复运行；不会触碰块外的用户配置。完成后打印重载命令。

### 文档

保留 README 中的使用形式，补充 shell 支持范围、安装后 `exec "$SHELL"`、显式 shell setup 的用法、未知 preset 错误行为，以及普通 Pi 参数原样透传的说明。

## 验证

使用 Node 内置 test runner，不增加测试框架依赖。

- 单元测试覆盖单个/多个/重复 preset、长参数等号形式、参数顺序、空名称、非法名称、缺失值、未知 preset 和 `--` 边界。
- 用临时目录中的假 `pi` 可执行文件做集成测试，验证 argv、cwd、stdin/stdout、退出码及普通调用透传，不访问真实 Pi 配置。
- 用临时 HOME/配置目录测试三种 shell 的 setup 产物与幂等性；对系统已安装的 shell 做语法或 function 级烟雾测试。
- 验证根安装脚本会保留 preset 本地依赖布局，并检查 README 示例所引用的 package 均存在。

## 留给实现者的细节

具体源文件拆分、shell 引号转义辅助函数、信号到退出码的常规数值映射、错误文案和测试 helper 命名可由实现者决定，不改变上述外部行为。
