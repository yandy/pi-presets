# TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 PR #1 的实现和测试完整迁移为严格 TypeScript，同时保持所有现有 CLI、shell 和安装行为不变。

**Architecture:** 利用 Node 22.19 默认启用的 type stripping 直接运行 `.ts`，不引入构建目录或运行时转译依赖；TypeScript 编译器只负责 `noEmit` 类型检查。

**Tech Stack:** TypeScript 5.9+、Node.js 22.19+ ESM、Node 内置 test runner、npm、fish/bash/zsh。

**Spec:** `docs/superpowers/specs/2026-11-20-typescript-migration-design.md`

## Global Constraints

- 公开 CLI、shell function、退出状态、stdio/cwd 和 preset 本地依赖安装行为不得改变。
- 所有项目 `src/` 与 `test/` 文件使用 `.ts`；相对导入显式写 `.ts`，类型导入使用 `import type`。
- 只使用 Node 可擦除 TS 语法，不生成 `dist/`。
- 保留 Node >=22.19，并在 22.19.0 上运行完整测试。
- 继续提交到 `feature/preset-cli` 并更新 PR #1。

## Review Focus

- Node 不做类型检查且不会读取 tsconfig，因此 strict 检查必须独立运行并覆盖测试文件。
- 非 `import type` 的类型导入会在 type stripping 后变成运行时错误；所有跨文件类型依赖都要显式标记。
- shell function 和根 postinstall 必须引用真实存在的 `.ts` 入口，特殊路径与本地依赖测试不得因重命名失效。
- 最低 Node 22.19 与当前 Node 都必须能发现并完成全部 28 项测试。
- 测试内嵌的扩展名无 `.ts` 假 Pi 仍是 CommonJS fixture，不应被误当作项目 JS 源码迁移。

---

### Task 1: 完整 TypeScript 迁移

**Files:**
- Rename: `src/cli.js` → `src/cli.ts`
- Rename: `src/presets.js` → `src/presets.ts`
- Rename: `src/shell-integration.js` → `src/shell-integration.ts`
- Rename: `src/setup.js` → `src/setup.ts`
- Rename: `src/install-presets.js` → `src/install-presets.ts`
- Rename: `test/*.test.js` → `test/*.test.ts`
- Create: `tsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

**Interfaces:**
- Preserves: `expandPresetArgs(args: readonly string[], presetsRoot: string): string[]`。
- Preserves: `listPresets(presetsRoot: string): string[]` 和 `PresetUsageError`。
- Preserves: `installShellIntegration()`、`installPresetDependencies()` 的外部行为，为参数、返回值和 runner 增加明确 TS 类型。
- Produces: `npm run typecheck`，对 `src/**/*.ts` 与 `test/**/*.ts` 执行严格 `tsc --noEmit`。

- [ ] **Step 1: 先迁移测试文件并更新其目标导入**

用 `git mv` 将四个测试文件改为 `.ts`，将 `../src/*.js` 导入改为对应的 `../src/*.ts`。为 test context、helper 参数、runner、捕获对象和临时 fixture 添加严格类型；保留全部 28 项行为断言，不把迁移后的测试改成更宽松的断言。测试内嵌假 Pi 的 CommonJS 字符串保持不变。

- [ ] **Step 2: 运行 TS 测试并确认因实现模块尚未迁移而失败**

Run: `node --test test/*.test.ts`
Expected: FAIL，`ERR_MODULE_NOT_FOUND` 指向尚未创建的 `src/*.ts`，而不是测试语法错误。

- [ ] **Step 3: 迁移实现并加入严格类型配置**

用 `git mv` 将五个实现文件改为 `.ts`，更新内部 `.ts` 导入及 shell 生成的 `src/cli.ts` 路径。为公开接口、进程 runner、options、caught errors、signal 和 manifest 添加类型；仅用可擦除语法。

新增 `tsconfig.json`，启用 `strict`、`noEmit`、`module: NodeNext`、`allowImportingTsExtensions`、`erasableSyntaxOnly`、`verbatimModuleSyntax`、`rewriteRelativeImportExtensions`，include 为 `src/**/*.ts` 和 `test/**/*.ts`。

根 package scripts 更新为 `node src/setup.ts`、`node src/install-presets.ts`、`node --test test/*.test.ts`，增加 `typecheck: tsc --noEmit`；开发依赖增加 `typescript` 与 Node 22 的 `@types/node`。

- [ ] **Step 4: 更新 lockfile 并验证真实 postinstall**

Run: `npm install --package-lock-only --ignore-scripts && npm install`
Expected: TypeScript 开发依赖安装成功；postinstall 直接执行 `src/install-presets.ts`，输出包含 `Installed dependencies for presets: coding`，且 `coding/node_modules/superpowers` 存在。

- [ ] **Step 5: 运行类型检查与当前 Node 全套测试**

Run: `npm run typecheck && npm test`
Expected: TypeScript 无错误；全部 28 项测试通过、0 跳过，包含三种 shell 的特殊路径 function 测试。

- [ ] **Step 6: 验证最低 Node 版本**

Run: `npx --yes node@22.19.0 --test test/*.test.ts`
Expected: Node 22.19.0 上全部 28 项测试通过、0 跳过，无 TS 语法或导入错误。

- [ ] **Step 7: 更新开发文档并做提交前验证**

README 增加 `npm run typecheck`，说明源码使用 Node 原生可擦除 TypeScript、无需构建。

Run: `npm run typecheck && npm test && git diff --check && git status --short`
Expected: 类型检查与测试通过，无 whitespace 错误，status 仅包含本迁移的设计、计划、TS 重命名、配置、lockfile 和 README。

- [ ] **Step 8: 提交并推送现有 PR 分支**

```bash
git add -A
git commit -m "refactor: migrate preset launcher to TypeScript"
git push
```

Expected: 新提交出现在 `feature/preset-cli`，PR #1 自动更新；worktree 保留且干净。
