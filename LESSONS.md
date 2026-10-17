# LESSONS — opencode-goal

> OpenCode V2 插件：给一个完成条件，agent 自动迭代直到满足。发布形态是单个 TypeScript 源文件（`src/index.ts`），无构建步骤，OpenCode 内置运行时直接加载。
> 本仓库从真实失误沉淀的「教训→规则」清单。**会话开始先全文阅读并遵循其中所有规则**；出现新失误按 §维护 追加。
> 权威依据：Anthropic Claude Code memory/best practices（<200 行、具体可验证、第二次犯同样错即写入）；社区 lessons.md 惯例（Boris Cherny，Anthropic）。
> 来源：本仓库 AGENTS.md 的关键约定 / 安全与边界 / 版本与 Release + 已验证 fix 提交；预填为种子，后续由 Agent 在真实工作中增长。

## 维护
- **触发**：用户纠正 / Agent 自查到的失误 / 非显而易见的 gotcha。
- **格式**：`### <主题>` 下，每条 = 失误（具体场景）→ 规则（最小可执行指令），一行可验证。
- **只记项目特有、不可从代码推断的**；通用最佳实践不写；含糊措辞（"小心""注意"）删掉。
- **重复出现** → 升级进 `AGENTS.md` 硬规则；**月度审阅**裁剪过期项；目标 < 200 行。

## 架构边界

- 失误：引入需要编译产物的构建链 → 规则：无构建无打包，`package.json` 的 `exports` 直接指向 `src/index.ts`（见 AGENTS.md「关键约定」）
- 失误：把具体供应商/模型写死进代码 → 规则：evaluator 模型走三级配置（plugin options > `~/.config/opencode-goal.json` > 环境变量），缺省时**不指定模型**（见 AGENTS.md「关键约定」）
- 失误：写文档时加入未验证的安装方式 → 规则：文档只保留验证过的安装方式（commit 7dbf0c4）
- 失误：插件假设自己可以改权限规则 → 规则：插件不改变 OpenCode 权限规则，需确认的操作照常弹确认（见 AGENTS.md「安全与边界」）

## 运行时行为约束（实测坑）

- 失误：改插件没读 README「实现笔记」，踩了已知坑 → 规则：改插件前先读实现笔记：循环推进用 `session.synthetic` + `delivery:"steer"`；事件需按 `sessionID` 过滤并按 `event.id` 去重；文件变更会触发多次热重载（见 AGENTS.md「关键约定」）
- 失误：目标状态在热重载/重启后丢失 → 规则：目标状态经 `ctx.storage` 持久化，恢复后置为暂停；改插件前先读 README「已知限制」（见 AGENTS.md「安全与边界」）
- 失误：synthetic 注入只传 `text` 没传 `description`，用户报「/goal 之后会话页看不到我发的提示词」——TUI 与 Web 会话页都按 `!message.description?.trim()` 丢弃 synthetic 消息（`packages/tui/src/routes/session/rows.ts`、`packages/session-ui/src/timeline/projection.ts`）→ 规则：凡需用户可见的 synthetic 注入必须同时传 `description`（渲染显示 description、隐藏 text）；只有纯内部机制（每轮循环指引）才省略它保持隐形（见 README「实现笔记」1）

## 质量与提交

- 失误：typecheck 有错误就提交 → 规则：`npm run typecheck`（tsc --noEmit）提交前必须零错误（见 AGENTS.md「命令」）
- 失误：直接提交到 `main` / 分支名不前缀 → 规则：分支用 `feature/xxx`、`fix/xxx`、`docs/xxx` 一类前缀式（见 AGENTS.md「关键约定」）
- 失误：提交信息只有 WHAT 没有 WHY → 规则：Conventional Commits，正文讲 WHY（diff 已说明 WHAT）（见 AGENTS.md「关键约定」）
- 失误：版本 bump 不看语义 → 规则：`feat` → minor、`fix` → patch；无对外行为变化不 bump（见 AGENTS.md「版本与 Release」）
- 失误：push tag / 触发 release 前没确认 → 规则：tag 与 release 是远程不可逆动作，先向用户确认（见 AGENTS.md「版本与 Release」）

## CI 与配置

- 失误：改 `.github/` 后 yaml 语法坏 → 规则：改 workflow 后校验，本机用 `ruby -e 'require "yaml"; YAML.load_file(...)'`（见 AGENTS.md「版本与 Release」）
- 失误：给 github-actions bot 申请了不存在的权限/输入 → 规则：Action 输入与 token 权限要对齐官方文档（commit 2c08f61 基建）
