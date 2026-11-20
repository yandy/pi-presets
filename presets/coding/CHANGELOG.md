# CHANGELOG

本组合包的变更记录：每次第三方依赖升/降级、清单路径变化都记一条。

## [0.1.0] - 2026-11-20

- 初始版本，`coding` 类。
- 新增依赖 `superpowers` `v7.0.2`（<https://github.com/obra/superpowers>，commit `22f0b463e7a5e579904dd6211a520321035526f7`），以 `git+https://github.com/obra/superpowers.git#v7.0.2` 声明。
- 提供 15 个 skills（`node_modules/*/skills` 命中 `node_modules/superpowers/skills`）与 1 个扩展（`node_modules/superpowers/.pi/extensions/superpowers.ts`）。
- 扩展写显式路径而非 glob：pi 的 glob 展开会丢弃含 `.` 开头路径段的匹配，`node_modules/*/.pi/extensions` 匹配不到。
- `package-lock.json` 的 `resolved` 手工固定为 `git+https://…`，替换 npm 默认写出的 `git+ssh://git@github.com/…`，避免要求 GitHub SSH key。
