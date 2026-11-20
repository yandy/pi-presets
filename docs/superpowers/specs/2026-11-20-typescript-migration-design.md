# TypeScript 迁移设计

## 意图

当前 PR #1 的实现与测试使用 JavaScript。用户明确偏好 TypeScript，并要求迁移当前 PR，同时保持已有 preset 行为和公开用法不变。

## 目标

- `src/` 的所有实现文件和 `test/` 的所有测试文件改为 TypeScript。
- 使用严格 TypeScript 类型检查，公开函数具有明确参数与返回类型。
- 保持 `pi -ps/--preset`、shell setup、依赖安装、stdio/cwd/退出状态等行为不变。
- 保留 Node.js >=22.19 的最低版本要求，并在该最低版本上运行测试。
- 继续更新现有 `feature/preset-cli` 分支和 PR #1。

## 非目标

- 不改变 preset 的 CLI 语法、shell 支持范围或目录结构。
- 不引入 `dist/`、运行时转译器、路径别名、enum、namespace 或其他需要代码生成的 TS 特性。
- 不迁移测试内嵌的临时假 Pi 脚本；它们是运行时生成的 CommonJS fixture，不是项目源文件。

## 方案比较

### Node 原生 TypeScript（已选择）

Node 22.18 起默认启用 type stripping，项目最低版本 22.19 因而可以直接执行只含可擦除语法的 `.ts`。使用 `tsc --noEmit` 补齐 Node 不做的类型检查。

优点：没有构建步骤和构建产物，shell function 可直接指向源码，运行时无额外依赖。约束：相对导入必须写 `.ts` 后缀，不能使用需要转译的 TS 语法。

### tsc 编译到 dist

可支持更老 Node 和完整 TS 转译，但会增加构建、入口路径和清理构建产物的复杂度；当前版本约束下没有收益。

### tsx 等运行时转译器

能支持更多 TS 特性，但需要额外运行时依赖；当前代码不需要这些特性，因此不采用。

## 实现设计

- 将 `src/*.js` 重命名为 `src/*.ts`，将 `test/*.test.js` 重命名为 `test/*.test.ts`。
- 所有相对导入显式使用 `.ts`；类型导入使用 `import type`。
- 新增 `tsconfig.json`：`strict`、`noEmit`、`module: NodeNext`、`allowImportingTsExtensions`、`erasableSyntaxOnly`、`verbatimModuleSyntax`，包含 `src/**/*.ts` 和 `test/**/*.ts`。
- 根开发依赖增加 `typescript` 与匹配 Node 22 的 `@types/node`；新增 `npm run typecheck`。
- `setup` 和 `postinstall` 直接执行对应 `.ts`，测试命令显式匹配 `test/*.test.ts`。
- shell 生成代码指向 `src/cli.ts`；安装器仍由根 postinstall 调用，npm 默认不会递归安装子目录，这一自定义行为不变。
- README 增加类型检查命令和原生 TS 的开发说明。

## 验证

- 先让迁移后的 TS 测试因目标 `.ts` 模块尚不存在而失败，再完成实现迁移。
- `npm run typecheck` 无错误。
- 当前 Node 上全部测试通过。
- 使用 Node 22.19.0 运行同一测试套件，验证最低版本兼容性。
- 再跑一次真实 `npm install`，确认 postinstall 能执行 TS 且 `coding` 的本地依赖布局不变。
- `git diff --check` 通过后提交并推送到 PR #1。
