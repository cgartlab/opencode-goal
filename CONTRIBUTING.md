# Contributing

感谢愿意帮忙。这个小插件只有**一个源文件**（`src/index.ts`），上手成本很低。

## 开发环境

```bash
git clone <repo-url> opencode-goal
cd opencode-goal
npm install
npm run typecheck   # tsc --noEmit
```

要求 Node ≥ 18（仅用于类型检查），以及一个可跑的 OpenCode V2 环境用于实测。

## 本地试用你的改动

OpenCode V2 会自动加载 `~/.config/opencode/plugins/` 下的插件（目录内含 `index.ts`，支持符号链接）：

```bash
mkdir -p ~/.config/opencode/plugins/opencode-goal
ln -s "$(pwd)/src/index.ts" ~/.config/opencode/plugins/opencode-goal/index.ts
```

改 `src/index.ts` 后 OpenCode 会**热重载**，无需重启（软链目录形态同样支持热重载）。

## 提交前自检

- [ ] `npm run typecheck` 零错误。
- [ ] 若改了插件行为，在真实 OpenCode 里手动跑一遍 `/goal`（至少覆盖：达成、`stop`、轮数上限三条路径）。
- [ ] 若改了对外行为（命令、配置项、终止条件），同步更新 `README.md`；用户可见的改动记进 `CHANGELOG.md` 的 `[Unreleased]`。
- [ ] 提交信息用 Conventional Commits（`<type>(<scope>): <description>`），正文讲 WHY。

## 提交 PR

1. 从 `main` 切出分支（`feature/xxx`、`fix/xxx`、`docs/xxx` 等前缀会触发自动标签）。
2. 一个 PR 一个意图；纯文档 / 修复 / 新功能尽量拆开。
3. PR 描述模板自动填充（`.github/pull_request_template.md`），写清改了什么、为什么、怎么验证的。
4. 提交信息用 Conventional Commits——它同时决定自动标签与版本号（`feat`→minor、`fix`→patch）。

## 版本与 Release

- 版本号：`package.json` / `package-lock.json` 同步 bump；`CHANGELOG.md` 加对应条目（Keep a Changelog）。
- 合并后发布：仓库 Actions → Release → Run workflow → 填版本号，自动打 tag 并创建 GitHub Release（body 取自 CHANGELOG 条目）。详见 README「版本与发布」。

## 不要做的事

- 不要把具体的供应商 / 模型 ID 硬编码进代码（evaluator 模型是配置项，见 README「配置」）。
- 不要引入构建步骤——发布形态就是 TypeScript 源文件（`exports` 直接指向 `src/index.ts`）。
- 不要改 `~/.config/opencode/opencode.json` 相关假设；插件配置走独立的 `~/.config/opencode-goal.json`。

## License

以 MIT 提交贡献（见 `LICENSE`）。
