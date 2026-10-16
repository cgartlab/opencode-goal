# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.0] - 2026-10-17

### Added

- `/goal --promise TOKEN`：完成承诺串。模型**当且仅当条件真正满足**时输出该串（精确包含）即判达成，
  跳过评估器（Ralph Wiggum 同款语义）；依赖模型自律，不得为脱身谎报。
- 持久化与恢复、`/goal resume` 均携带完成承诺设置。

## [0.2.0] - 2026-10-17

### Added

- 生命周期命令：`/goal pause` / `resume` / `clear`；再次 `/goal <条件>` 直接替换旧目标（对齐 Claude `/goal` 与 Codex Goals）。
- 目标状态持久化（`ctx.storage`）：热重载/重启不丢，恢复后置为暂停，等待用户消息或 `/goal resume` 再续跑。
- 无进展检测与预算耗尽改为「暂停（保留目标）」并注入「总结卡点/下一步」提示，而非直接结束。
- 条件长度校验（≤ 4000 字符）。
- 失败分档：不可恢复错误（认证 / 余额 / 上下文溢出 / 模型不可用）自动清除目标。
- 压缩保护：目标条件追加进上下文压缩摘要（尽力而为，不接管压缩）。

### Changed

- 默认不再设轮数上限（`maxTurns` 默认 0 = 不设限），可用 `--turns` / `--mins` / `maxTurns` 显式限界。
- 循环推进改用 `session.synthetic` + `delivery:"steer"`（不再伪造用户消息；修正此前「用 prompt 而非 synthetic」的实现笔记——synthetic 需显式 `steer` 投递才可靠）。
- 进程内 `globalThis` 单例共享状态，抵御 watcher 重载风暴导致的实例并存。
- 评估证据窗口可配置（`evidenceWindow`，默认 6）。

## [0.1.0] - 2026-10-16

### Added

- 首个版本：把 Claude Code 的 `/goal`（目标型自动迭代循环）搬到 OpenCode V2。
  - 每轮会话执行结束后，由独立的 evaluator 模型读取「目标条件 + 最近一轮输出」，
    判定三态 `met` / `not_met` / `impossible`；判为 `not_met` 时把评估理由作为下一轮指引注入。
  - 命令：`/goal <条件>` 启动、`/goal` 查看状态、`/goal stop` 停止、`/goal help` 说明。
  - 护栏：轮数上限（默认 10，`--turns N`）、时间上限（`--mins M`）、
    连续无工具轮数达上限（默认 3）判为无进展并停止。
  - 终止条件：目标达成 / 判定不可能 / 预算耗尽 / 无进展 / Esc 中断 / `/goal stop`。
  - 三级配置：plugin options > `~/.config/opencode-goal.json` > 环境变量；
    不内置任何模型，缺省使用 OpenCode 默认模型。
  - evaluator 经 `ctx.generate.text` 调用：不创建会话、不调用工具、不进会话历史。
