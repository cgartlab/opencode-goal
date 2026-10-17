# opencode-goal

[![Release](https://img.shields.io/github/v/release/cgartlab/opencode-goal)](https://github.com/cgartlab/opencode-goal/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenCode plugin](https://img.shields.io/badge/OpenCode-plugin-5B8DEF)](https://opencode.ai)

一个 OpenCode V2 插件：**给一个目标条件，agent 自动迭代直到条件满足**——Claude Code `/goal` 思路的开源实现。

> A goal-oriented auto-iteration loop plugin for OpenCode V2.
> You set a completion condition; an independent evaluator model judges it after every turn and keeps the session working until it's met (or judged impossible / out of budget).
> Distinct features: three-tier configuration, no hard-coded model, persisted goal state (survives restart), and implementation notes verified against the real OpenCode V2 runtime.

## 它解决什么问题

OpenCode 的一轮对话结束时，agent 会把控制权交回给你。复杂任务（"迁移这个模块直到所有调用点都能编译"、"修到测试全绿"）需要你自己一次次催它继续。

`opencode-goal` 把这件事自动化：条件写清楚，循环自己转，达标或证明不可能才停。

**与"定时循环"的区别**：定时循环按时间间隔重跑（适合盯 CI、盯部署）；本插件是按**完成条件**驱动，适合"做到某件事为止"的任务。

## 安装

OpenCode V2 会自动加载 `~/.config/opencode/plugins/` 下的插件（目录内含 `index.ts`，也支持符号链接）：

```sh
git clone https://github.com/cgartlab/opencode-goal.git
mkdir -p ~/.config/opencode/plugins/opencode-goal
ln -s "$(pwd)/opencode-goal/src/index.ts" \
      ~/.config/opencode/plugins/opencode-goal/index.ts
```

或直接把 `src/index.ts` 复制过去。改源码后 OpenCode 会热重载插件，无需重启。

## 用法

```
/goal <条件>          启动循环（已有目标则替换）
/goal                 查看状态（条件 / 状态 / 轮次 / 最近评估 / 历史达成）
/goal pause           暂停（保留目标）
/goal resume          恢复
/goal clear           清除（stop / off / reset / none / cancel 同义）
/goal help            用法说明与条件模板
/goal --turns 5 <条件>   限制最多 5 轮（默认不设限）
/goal --mins 30 <条件>   限制最多 30 分钟
/goal --promise T <条件>  完成承诺串：模型输出它（精确包含）即判达成，省一次评估
```

`--promise` 给一个完成承诺串（如 `DONE`）：启动与每轮指引都会告诉模型"**当且仅当条件真正满足**时单独一行输出它"。模型输出即达成（跳过评估器，省一次调用）——Ralph Wiggum 同款语义，**依赖模型自律**，条件请写得让模型无法"以为完成"。

一个会话同时只有一个目标：再次 `/goal <条件>` 会**替换**当前目标；`pause` 后目标保留，`resume` 继续。目标状态会**持久化**，热重载或重启后从磁盘恢复（恢复后为暂停态，等你发消息或 `resume` 再续跑）。

### 条件怎么写（决定成败）

评估器**只读对话里出现过的证据**，不自己跑命令。所以条件要写成"agent 的输出能证明"的形式（参考 Codex 完成契约的六要素，按需取舍）：

| 要素 | 说明 | 例 |
|---|---|---|
| ① 结果 | 完成时什么为真（可测量） | `p95 延迟 < 120ms` / `npm test 退出码为 0` |
| ② 验证方式 | 怎么证明 | `运行 npm test 并把输出贴出来` |
| ③ 约束 | 途中什么不能变 | `不得修改其他测试文件` |
| ④ 边界 | 能碰哪些、不能碰哪些 | `只改 checkout 服务` |
| ⑤ 迭代策略 | 每轮记录什么、下轮试什么 | `记录失败用例与下一步尝试` |
| ⑥ 卡点条件 | 卡住时停并报告什么 | `若无法复现，停下报告证据与所需输入` |

**好**：`/goal 让 test/auth 下所有测试通过，用 npm test 输出证明；不得修改其他测试文件；每轮记录失败用例与下一步尝试；若无法复现则停下报告证据与所需输入`

**差**：`/goal 改进一下认证代码` —— 没有终态，评估器无从判断，会一直推进。

条件上限 4000 字符（对齐 Claude `/goal`）。

## 配置

优先级：**plugin options > `~/.config/opencode-goal.json` > 环境变量**。

| 项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `evaluatorModel` | `{ providerID, id }` | 不指定 | 评估器模型；缺省则用 OpenCode 默认模型 |
| `maxTurns` | number | 0 | 轮数上限；**0 = 不设限**，>0 则生效 |
| `noProgressLimit` | number | 3 | 连续无工具轮数达此值判为无进展并暂停 |
| `maxConditionLength` | number | 4000 | 条件最大字符数（对齐 Claude /goal） |
| `evidenceWindow` | number | 6 | 评估证据取最近几条 assistant 输出 |
| `logFile` | string | `~/.local/state/opencode-goal/goal.log` | 日志路径；`"off"` 关闭 |

配置文件示例：

```json
{
  "evaluatorModel": { "providerID": "anthropic", "id": "claude-haiku-4-5" },
  "noProgressLimit": 3,
  "evidenceWindow": 6
}
```

（需要硬轮数上限时，加 `"maxTurns": 10` 即可。）

环境变量（模型格式 `providerID/modelID`，模型 ID 可含 `/`）：

```sh
export OPENCODE_GOAL_EVALUATOR_MODEL="anthropic/claude-haiku-4-5"
export OPENCODE_GOAL_LOG_FILE="~/goal.log"
```

> 建议评估器用**便宜的小模型**：它每轮跑一次，只做判定不干活。任何 OpenCode 可用模型都行，包括本地网关的路由组。

## 工作原理

```
/goal <条件>
   │
   ├─ 注入起点提示（说明条件 + 让 agent 自主工作、不要自行宣布完成）
   │
   ▼
┌─ 会话执行一轮 ─────────────────────────────┐
│  agent 读文件 / 跑命令 / 改代码 …           │
└────────────────────────────────────────────┘
   │ session.execution.succeeded
   ▼
读取最近 assistant 输出作为证据
   │
   ▼
独立模型评估（ctx.generate.text，不调工具、不进会话历史）
   │
   ├─ met        → ✓ 结束
   ├─ impossible → ✗ 结束（条件不可能满足）
   └─ not_met    → 把评估理由作为下一轮指引注入 → 回到执行一轮
```

**终止 / 暂停条件**：目标达成（✓） / 判定不可能（✗） / 达到轮数或时间上限（**暂停**，保留目标） / 连续无进展（**暂停**） / 你按 Esc（暂停） / `/goal clear`（清除）。

**安全**：插件不改变权限规则。需要确认的操作照常弹确认；要无人值守请自行配合 auto mode。

## 实现笔记（实测，供插件作者参考）

以下结论均在本机 OpenCode V2 上实测得出，部分与官方文档的表述不同：

1. **循环推进用 `session.synthetic` + `delivery:"steer"`**（实测可靠，且不伪造用户消息）。踩过的坑：synthetic **不指定 delivery**（默认入队语义）时，idle 会话存在"入队但不被立即拉取"的窗口，消息滞留到下一次外部消息才被消费（表现为"结论不出现、循环停住"）。显式传 `delivery: "steer"` 后立即触发执行。`session.prompt`（user 语义）用于**用户自己的输入**（如 `/goal <条件>` 启动：命令本身不会自动进转录，用它把用户的命令以真实 user 消息留底）；非用户输入（每轮循环指引、状态/结论通知）仍用 synthetic，避免伪造用户消息。**另一个必须踩过的坑**：synthetic **不带 `description` 时界面完全不渲染**——渲染器按 `message.type === "synthetic" && !message.description?.trim()` 直接跳过该消息（TUI `packages/tui/src/routes/session/rows.ts`、Web 会话页 `packages/session-ui/src/timeline/projection.ts` 的 `isNotice`；强制可见仅覆盖 `metadata.state === "error"` 与失败 shell 完成）。渲染时显示的是 `description`（无 metadata 时按 `◈ Notice` 行换行显示），`text` 只在转录数据里。**凡是需要用户看到的注入，`text` 与 `description` 都要传**；只有纯内部机制（如每轮循环指引）才故意省略 `description` 让它保持隐形。
2. **`ctx.model.list()` 返回 `{ location, data }` 对象，不是数组**，模型列表在 `data`。
3. **插件事件流是全服务广播**，且同一事件会被重复投递——需按 `event.data.sessionID` 过滤目标会话，并**按 `event.id` 去重**（否则一次 idle 会触发多次评估与注入）。
4. **`ctx.generate.text` 的 `model` 可省略**（OpenAPI 中为 `Model.Ref | null`），省略时用默认模型。
5. **插件自动发现**扫描插件目录下的 `plugin/` 与 `plugins/`，支持单文件、目录与符号链接，且文件变更会热重载。
6. 评估器**看不到文件系统**，判断依据仅限对话转录——这是"条件要能被输出证明"的根本原因。

## 已知限制

- **防空转**：连续无工具轮数触发**暂停**的路径未做端到端复现（设计"条件不可达且 agent 不用工具"的场景时，agent 要么满足了条件、要么自己去用工具，本身是合理行为）。逻辑简单，已代码审查；触发后为暂停（保留目标）而非终态。
- **无默认轮数上限**：对齐 Claude `/goal`（默认不设限），靠无进展检测 + 可选的 `--mins` / `--turns` / `maxTurns` 兜底。若条件写得让模型能一直"用工具但永不满足"，循环可能持续很久——需要时请显式设限。
- **Esc 中断**：事件处理已实现（`session.execution.interrupted` → 暂停），但未在真实 TUI 中人工验证。
- **恢复后暂停**：从磁盘恢复的目标**有意置为暂停**（热重载/重启不自动续跑），等你在该会话发消息或 `/goal resume` 才继续。
- **终态多一轮**：结束/状态类消息以 synthetic 注入，会触发一次模型的简短确认回复（多花一次廉价调用），换来结论必然可见——**前提是注入带 `description`**（不带则界面不渲染，见实现笔记 1）。每轮循环指引刻意不带 `description`，保持隐形以免长循环刷屏；进度请看模型每轮自己的可见回复，或用 `/goal` 查状态。
- **单会话单目标**（再次 `/goal` 替换，不叠加）。
- **完成承诺靠模型自律**：`--promise` 命中即判达成、跳过评估器。模型若在条件未满足时输出承诺串会被误判完成——这是有意取舍（省一次评估），条件请写得让模型无法"以为完成"。

## 版本与发布

- 语义化版本：`feat` → minor，`fix` → patch；无对外行为变化不 bump。
- 版本承载：`package.json` / `package-lock.json`；更新记录 `CHANGELOG.md`（Keep a Changelog）。
- 发布流程（自动化，见 `.github/workflows/release.yml`）：
  1. 合并含版本 bump 的 PR（代码 + CHANGELOG 同步）。
  2. 仓库 **Actions → Release → Run workflow**，填版本号（如 `0.4.0`）。
  3. workflow 自动打 tag `v0.4.0`，随即触发 Release：从 `CHANGELOG.md` 提取该版本条目并创建 GitHub Release。
- 自动标签（`.github/workflows/labeler.yml`）：`feature/*` → feat、`fix*` → fix、`docs*`/`**/*.md` → docs、`chore*` → chore、`.github/**` → infra。
- Issue / PR 模板：`.github/ISSUE_TEMPLATE/`、`.github/pull_request_template.md`。

## License

MIT
