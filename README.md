# opencode-goal

一个 OpenCode V2 插件：**给一个目标条件，agent 自动迭代直到条件满足**——Claude Code `/goal` 思路的开源实现。

> A goal-oriented auto-iteration loop plugin for OpenCode V2.
> You set a completion condition; an independent evaluator model judges it after every turn and keeps the session working until it's met (or judged impossible / out of budget).
> Distinct features: three-tier configuration, no hard-coded model, and implementation notes verified against the real OpenCode V2 runtime.

## 它解决什么问题

OpenCode 的一轮对话结束时，agent 会把控制权交回给你。复杂任务（"迁移这个模块直到所有调用点都能编译"、"修到测试全绿"）需要你自己一次次催它继续。

`opencode-goal` 把这件事自动化：条件写清楚，循环自己转，达标或证明不可能才停。

**与"定时循环"的区别**：定时循环按时间间隔重跑（适合盯 CI、盯部署）；本插件是按**完成条件**驱动，适合"做到某件事为止"的任务。

## 安装

### 方式一：本地插件目录（已验证）

OpenCode V2 会自动加载 `~/.config/opencode/plugins/` 下的插件（目录内含 `index.ts`，也支持符号链接）。

```sh
git clone <repo-url> ~/Documents/github-repos/opencode-goal
mkdir -p ~/.config/opencode/plugins/opencode-goal
ln -s ~/Documents/github-repos/opencode-goal/src/index.ts \
      ~/.config/opencode/plugins/opencode-goal/index.ts
```

或直接把 `src/index.ts` 复制过去。改源码后 OpenCode 会热重载插件，无需重启。

### 方式二：作为 npm 包（需先发布，未验证）

发布到 npm 后写入配置：

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-goal"]
}
```

> 说明：`plugins` 数组引用包名/本地目录的形式**未在本项目验证**（本项目当前未发布 npm）。已实测可用的是方式一。

## 用法

```
/goal <条件>          启动循环
/goal                 查看状态（轮次 / 条件 / 最近评估）
/goal stop            停止（clear / cancel / off / reset / none / abort 同义）
/goal help            用法说明
/goal --turns 5 <条件>   限制最多 5 轮
/goal --mins 30 <条件>   限制最多 30 分钟
```

一个会话同时只有一个目标；重复启动会被拒绝，需先 `stop`。

### 条件怎么写（决定成败）

评估器**只读对话里出现过的证据**，不自己跑命令。所以条件要写成"agent 的输出能证明"的形式：

| 要素 | 说明 | 例 |
|---|---|---|
| 可测量的终态 | 测试结果 / 退出码 / 文件数 / 队列空 | `npm test 退出码为 0` |
| 明确的检查方式 | agent 该如何证明 | `运行 npm test 并把输出贴出来` |
| 不可变的约束 | 途中不能改变的东西 | `不得修改其他测试文件` |

**好**：`/goal 让 test/auth 下所有测试通过，用 npm test 输出证明；不得修改其他测试文件`

**差**：`/goal 改进一下认证代码` —— 没有终态，会空转到轮数上限。

## 配置

优先级：**plugin options > `~/.config/opencode-goal.json` > 环境变量**。

| 项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `evaluatorModel` | `{ providerID, id }` | 不指定 | 评估器模型；缺省则用 OpenCode 默认模型 |
| `maxTurns` | number | 10 | 轮数上限 |
| `noProgressLimit` | number | 3 | 连续无工具轮数达此值判为无进展并停止 |
| `logFile` | string | `~/.local/state/opencode-goal/goal.log` | 日志路径；`"off"` 关闭 |

配置文件示例：

```json
{
  "evaluatorModel": { "providerID": "anthropic", "id": "claude-haiku-4-5" },
  "maxTurns": 10
}
```

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

**终止条件**：目标达成 / 判定不可能 / 达到轮数或时间上限 / 连续无进展 / 你按 Esc / `/goal stop`。

**安全**：插件不改变权限规则。需要确认的操作照常弹确认；要无人值守请自行配合 auto mode。

## 实现笔记（实测，供插件作者参考）

以下结论均在本机 OpenCode V2 上实测得出，部分与官方文档的表述不同：

1. **推进循环要用 `session.prompt`，不要用 `session.synthetic`。** synthetic 在会话 idle 时入队 inbox 后，存在不被立即拉取的窗口——实测消息会滞留在队列里，直到下一次外部消息才被消费（表现为"结论消息不出现、循环停住"）。`session.prompt`（user 输入语义）总是立即触发执行。synthetic 更适合不需要立即行动的旁路通知。
2. **`ctx.model.list()` 返回 `{ location, data }` 对象，不是数组**，模型列表在 `data`。
3. **插件事件流是全服务广播**，且同一事件会被重复投递——需按 `event.data.sessionID` 过滤目标会话，并**按 `event.id` 去重**（否则一次 idle 会触发多次评估与注入）。
4. **`ctx.generate.text` 的 `model` 可省略**（OpenAPI 中为 `Model.Ref | null`），省略时用默认模型。
5. **插件自动发现**扫描插件目录下的 `plugin/` 与 `plugins/`，支持单文件、目录与符号链接，且文件变更会热重载。
6. 评估器**看不到文件系统**，判断依据仅限对话转录——这是"条件要能被输出证明"的根本原因。

## 已知限制

- **防空转**：连续无工具轮数的停止路径未做端到端复现（设计"条件不可达且 agent 不用工具"的场景时，agent 要么满足了条件、要么自己去用工具，本身是合理行为）。逻辑简单，已代码审查。
- **Esc 中断**：事件处理已实现（`session.execution.interrupted`），但未在真实 TUI 中人工验证。
- **终态多一轮**：结束/状态类消息以用户消息注入，会触发一次模型的简短确认回复（多花一次廉价调用），换来结论必然可见。
- **状态在内存中**：重启 OpenCode 后进行中的目标状态丢失（不会自动恢复循环）。
- **单会话单目标**。

## License

MIT
