# AGENTS.md — opencode-goal

给 AI 编码代理（Claude Code / OpenCode / Cursor 等）看的仓库约定。人读的贡献指引见 `CONTRIBUTING.md`。

## 这是什么

OpenCode V2 插件：给一个完成条件，agent 自动迭代直到条件满足（Claude Code `/goal` 思路的开源实现）。
发布形态是**单个 TypeScript 源文件**，OpenCode 内置运行时直接加载，无构建步骤。

## 目录结构

```
opencode-goal/
├── src/index.ts        # 插件全部实现（唯一源文件）
├── package.json        # exports "." → ./src/index.ts；无构建
├── tsconfig.json       # 仅用于类型检查（noEmit）
├── README.md           # 用户文档（中文为主 + 英文摘要）
├── CHANGELOG.md        # 更新记录（Keep a Changelog）
└── examples/           # 配置示例
```

## 命令

```bash
npm install          # 安装开发依赖（@opencode/plugin / typescript / @types/node）
npm run typecheck    # tsc --noEmit，提交前必须零错误
```

无 build / test 脚本。改完 `src/index.ts` 直接生效（见下）。

## 关键约定

- **无构建、无打包**：`package.json` 的 `exports` 直接指向 `src/index.ts`。不要引入需要编译产物的构建链。
- **不硬编码模型**：evaluator 模型走三级配置（plugin options > `~/.config/opencode-goal.json` > 环境变量），
  缺省时**不指定模型**、用 OpenCode 默认。任何 PR 都不得把具体供应商/模型写死进代码——避免把个人网关带进开源代码。
- **提交信息用 Conventional Commits**：`<type>(<scope>): <description>`。正文讲 **WHY**（diff 已说明 WHAT）。
- **分支命名**：`feature/xxx`、`fix/xxx`、`docs/xxx` 一类前缀式（勿直接提交到 `main`）。
- **改插件前先读 `README.md` 的「实现笔记」**：那里记录了实测得出的 OpenCode V2 行为约束
  （如用 `session.prompt` 而非 `session.synthetic`、事件需按 `sessionID` 过滤并按 `event.id` 去重），
  照着改能避开已知坑。

## 安全与边界

- 插件不改变 OpenCode 的权限规则；需要确认的操作照常弹确认。
- 插件状态存内存，重启丢失——这是已知设计取舍，改动前先读 README「已知限制」。
