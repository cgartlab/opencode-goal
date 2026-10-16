# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
