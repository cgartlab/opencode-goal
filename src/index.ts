/**
 * opencode-goal — 直到条件满足的自动迭代循环（v0.2.0）
 *
 * 机制（对齐 Claude Code /goal 与 Codex Goals 的官方做法）：
 *  - 每轮会话执行结束（session.execution.succeeded）后，用独立模型（evaluator）
 *    读取目标条件 + 最近对话证据，判定三态：
 *      met        → 循环成功结束（记 achieved 历史）
 *      not_met    → 继续：把评估理由作为下一轮指引注入会话
 *      impossible → 条件无法满足，循环失败结束
 *  - evaluator 经 ctx.generate.text 调用：不创建会话、不调用工具、不进会话历史。
 *  - 注入用 ctx.session.synthetic + delivery:"steer"（实测可靠，且不伪造用户消息）。
 *  - 护栏与生命周期（v0.2.0 对齐官方）：
 *      · 默认不设轮数上限（maxTurns=0），--turns N / --mins M 显式限界；
 *      · 连续无工具轮数达上限（默认 3）→ 暂停（保留目标，不是终态）；
 *      · 时间/轮数预算耗尽 → 暂停并注入「总结卡点/下一步」提示；
 *      · /goal pause / resume / clear；新目标直接替换旧目标；
 *      · 目标状态经 ctx.storage 持久化（热重载/重启不丢，恢复后置 paused）；
 *      · session.execution.failed 由 retry 钩子分档（不可修错误清目标）；
 *      · 进程内 globalThis 单例共享状态，抵御 watcher 重载风暴的实例并存。
 *
 * 命令：
 *  /goal <condition>                 启动 / 替换
 *  /goal                             查看状态
 *  /goal pause|resume|clear|help     生命周期与帮助（clear 的别名 stop/off/reset/none/cancel）
 *  /goal --promise TOKEN <condition>  完成承诺串：模型输出它（精确包含）即判达成（v0.3.0）
 *
 * 配置（优先级：plugin options > ~/.config/opencode-goal.json > 环境变量）：
 *    evaluatorModel   评估器模型 { providerID, id }；缺省则不指定模型
 *    maxTurns         轮数上限，默认 0 = 不设限（>0 则生效）
 *    noProgressLimit  连续无工具轮数上限，默认 3
 *    maxConditionLength  条件最大字符数，默认 4000（对齐 Claude /goal）
 *    evidenceWindow   评估证据取最近几条 assistant 文本，默认 6
 *    logFile          日志路径，默认 ~/.local/state/opencode-goal/goal.log；"off" 关闭
 *  环境变量：OPENCODE_GOAL_EVALUATOR_MODEL="providerID/modelID"、OPENCODE_GOAL_LOG_FILE
 */
import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** ---- 常量 ---- */
const PLUGIN_ID = "opencode-goal"
const DEFAULT_MAX_TURNS = 0 // 0 = 不设上限（贴近 Claude /goal 官方行为）
const DEFAULT_NO_PROGRESS_LIMIT = 3
const DEFAULT_MAX_CONDITION_LENGTH = 4000
const DEFAULT_EVIDENCE_WINDOW = 6
const SEEN_EVENT_CAP = 4000
const CONFIG_PATH = join(homedir(), ".config", "opencode-goal.json")
const DEFAULT_LOG_FILE = join(homedir(), ".local", "state", "opencode-goal", "goal.log")
const GOAL_STORAGE_PREFIX = "goal/"
const HISTORY_STORAGE_PREFIX = "goal-history/"

/** ---- 配置 ---- */
interface ModelRef {
  providerID: string
  id: string
}

interface GoalConfig {
  evaluatorModel: ModelRef | undefined
  maxTurns: number
  noProgressLimit: number
  maxConditionLength: number
  evidenceWindow: number
  logFile: string | null
}

function asModelRef(v: unknown): ModelRef | undefined {
  if (!v || typeof v !== "object") return undefined
  const o = v as Record<string, unknown>
  if (typeof o.providerID !== "string" || typeof o.id !== "string") return undefined
  return { providerID: o.providerID, id: o.id }
}

function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt
}

function readConfigFile(): Partial<GoalConfig> {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return {}
    const out: Partial<GoalConfig> = {}
    const model = asModelRef(parsed.evaluatorModel)
    if (model) out.evaluatorModel = model
    if (typeof parsed.maxTurns === "number") out.maxTurns = parsed.maxTurns
    if (typeof parsed.noProgressLimit === "number") out.noProgressLimit = parsed.noProgressLimit
    if (typeof parsed.maxConditionLength === "number") out.maxConditionLength = parsed.maxConditionLength
    if (typeof parsed.evidenceWindow === "number") out.evidenceWindow = parsed.evidenceWindow
    if (typeof parsed.logFile === "string") out.logFile = parsed.logFile
    return out
  } catch {
    return {}
  }
}

function readPluginOptions(options: unknown): Partial<GoalConfig> {
  if (!options || typeof options !== "object") return {}
  const o = options as Record<string, unknown>
  const out: Partial<GoalConfig> = {}
  const model = asModelRef(o.evaluatorModel)
  if (model) out.evaluatorModel = model
  if (typeof o.maxTurns === "number") out.maxTurns = o.maxTurns
  if (typeof o.noProgressLimit === "number") out.noProgressLimit = o.noProgressLimit
  if (typeof o.maxConditionLength === "number") out.maxConditionLength = o.maxConditionLength
  if (typeof o.evidenceWindow === "number") out.evidenceWindow = o.evidenceWindow
  if (typeof o.logFile === "string") out.logFile = o.logFile
  return out
}

/** 环境变量格式："providerID/modelID"（modelID 可含 "/"，如 magpie/group/cheap-first） */
function parseModelEnv(v: string | undefined): ModelRef | undefined {
  if (!v) return undefined
  const idx = v.indexOf("/")
  if (idx <= 0) return undefined
  return { providerID: v.slice(0, idx), id: v.slice(idx + 1) }
}

function resolveConfig(options: unknown): GoalConfig {
  const file = readConfigFile()
  const opts = readPluginOptions(options)
  const envModel = parseModelEnv(process.env.OPENCODE_GOAL_EVALUATOR_MODEL)
  const envLog = process.env.OPENCODE_GOAL_LOG_FILE
  const rawLog = opts.logFile ?? file.logFile ?? envLog ?? DEFAULT_LOG_FILE
  return {
    evaluatorModel: opts.evaluatorModel ?? file.evaluatorModel ?? envModel,
    maxTurns: opts.maxTurns ?? file.maxTurns ?? DEFAULT_MAX_TURNS,
    noProgressLimit: opts.noProgressLimit ?? file.noProgressLimit ?? DEFAULT_NO_PROGRESS_LIMIT,
    maxConditionLength: opts.maxConditionLength ?? file.maxConditionLength ?? DEFAULT_MAX_CONDITION_LENGTH,
    evidenceWindow: opts.evidenceWindow ?? file.evidenceWindow ?? DEFAULT_EVIDENCE_WINDOW,
    logFile: rawLog === "off" ? null : rawLog.replace(/^~/, homedir()),
  }
}

function makeLogger(logFile: string | null): (s: string) => void {
  if (!logFile) return () => {}
  try {
    mkdirSync(dirname(logFile), { recursive: true })
  } catch {}
  return (s: string) => {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${s}\n`)
    } catch {}
  }
}

/** ---- 进程内单例：热重载/实例并存时不丢状态（storage 兜底跨进程） ---- */
interface GoalRuntime {
  goals: Map<string, GoalState>
  evaluating: Set<string> // 正在评估的会话（重入锁）
  seenEvents: Set<string>
}
interface GlobalWithGoal {
  __opencodeGoal?: GoalRuntime
}
const G: GoalRuntime = ((globalThis as GlobalWithGoal).__opencodeGoal ??= {
  goals: new Map(),
  evaluating: new Set(),
  seenEvents: new Set(),
})

/** ---- 类型 ---- */
type Phase = "running" | "paused" | "done" | "failed" | "cleared"

interface GoalState {
  sessionID: string
  condition: string
  turns: number // 已注入的迭代轮数（已评估轮次）
  maxTurns: number // 0 = 不设上限
  maxMinutes: number | null
  promise: string | null // 完成承诺 token；模型输出该串（精确包含）即快速判 met
  startedAt: number
  phase: Phase
  lastReason: string
  noProgressStreak: number
  endedAt: number | null
  restoredFromDisk: boolean // 从 storage 恢复的（有意置 paused）
}

interface PersistedGoal {
  condition: string
  turns: number
  maxTurns: number
  maxMinutes: number | null
  promise: string | null
  startedAt: number
  phase: Phase
  lastReason: string
  noProgressStreak: number
}

interface AchievedEntry {
  condition: string
  turns: number
  durationMs: number
  at: number
}

interface EvalVerdict {
  verdict: "met" | "not_met" | "impossible"
  reason: string
}

/** assistant 会话消息的实际形状（实测自 OpenCode V2 session.context） */
interface AssistantMsg {
  type?: string
  content?: Array<{ type?: string; text?: string }>
}

const CLEAR_WORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel", "abort"])
const HELP_WORDS = new Set(["help", "h", "?"])

/** 不可恢复错误关键词：命中即清目标（对齐 Claude /goal「你必须修的错」） */
const UNRECOVERABLE_KEYWORDS = [
  "auth", "unauthorized", "forbidden", "401", "403",
  "credit", "balance", "quota", "insufficient",
  "context length", "context overflow", "token limit",
  "not available", "unavailable", "not found", "does not exist",
]

/** ---- 纯函数 ---- */
function parseStart(
  text: string,
  defaultMaxTurns: number,
): { condition: string; maxTurns: number; maxMinutes: number | null; promise: string | null } {
  let t = text.trim()
  let maxTurns = defaultMaxTurns
  let maxMinutes: number | null = null
  let promise: string | null = null
  const turns = t.match(/--turns?\s+(\d+)/i)
  if (turns) {
    maxTurns = Math.max(1, Math.min(500, Number(turns[1])))
    t = t.replace(/--turns?\s+\d+/i, "")
  }
  const mins = t.match(/--mins?\s+(\d+)/i) ?? t.match(/--max-minutes?\s+(\d+)/i)
  if (mins) {
    maxMinutes = Math.max(1, Number(mins[1]))
    t = t.replace(/--(?:max-)?minutes?\s+\d+/i, "")
  }
  const pm = t.match(/--promise\s+(?:"([^"]*)"|'([^']*)'|(\S+))/i)
  if (pm) {
    promise = (pm[1] ?? pm[2] ?? pm[3]) || null
    t = t.replace(/--promise\s+(?:"[^"]*"|'[^']*'|\S+)/i, "")
  }
  return { condition: t.trim(), maxTurns, maxMinutes, promise }
}

/** 取最近若干条 assistant 消息的正文，并判断最近一轮是否调用了工具 */
function lastAssistantInfo(messages: unknown[], count: number): { texts: string[]; usedTool: boolean } {
  const texts: string[] = []
  let usedTool = false
  for (let i = messages.length - 1; i >= 0 && texts.length < count; i--) {
    const m = messages[i] as AssistantMsg
    if (m?.type !== "assistant") continue
    const content = Array.isArray(m.content) ? m.content : []
    const text = content
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
      .trim()
    if (text) texts.unshift(text)
    if (content.some((p) => p.type === "tool")) usedTool = true
  }
  return { texts, usedTool }
}

function extractVerdict(raw: string): EvalVerdict {
  const m = raw.match(/\{[\s\S]*?\}/)
  if (!m) return { verdict: "not_met", reason: "评估器输出无法解析，按未完成处理" }
  try {
    const parsed = JSON.parse(m[0]) as Partial<EvalVerdict>
    const verdict = parsed.verdict === "met" || parsed.verdict === "impossible" ? parsed.verdict : "not_met"
    return { verdict, reason: (parsed.reason ?? "").slice(0, 500) || "（无理由）" }
  } catch {
    return { verdict: "not_met", reason: "评估器输出无法解析，按未完成处理" }
  }
}

function isUnrecoverable(type: string, message: string): boolean {
  const hay = `${type} ${message}`.toLowerCase()
  return UNRECOVERABLE_KEYWORDS.some((k) => hay.includes(k))
}

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = resolveConfig((ctx as { options?: unknown }).options)
    const log = makeLogger(config.logFile)
    const modelLabel = config.evaluatorModel
      ? `${config.evaluatorModel.providerID}/${config.evaluatorModel.id}`
      : "(未指定，使用 OpenCode 默认)"
    log(
      `setup begin evaluator=${modelLabel} maxTurns=${config.maxTurns}${
        config.maxTurns === 0 ? "(不设限)" : ""
      } noProgressLimit=${config.noProgressLimit} evidenceWindow=${config.evidenceWindow}`,
    )

    /** ---- storage 持久化 ---- */
    function persistGoal(g: GoalState): void {
      if (g.phase === "done" || g.phase === "failed" || g.phase === "cleared") return
      const p: PersistedGoal = {
        condition: g.condition,
        turns: g.turns,
        maxTurns: g.maxTurns,
        maxMinutes: g.maxMinutes,
        promise: g.promise,
        startedAt: g.startedAt,
        phase: g.phase,
        lastReason: g.lastReason,
        noProgressStreak: g.noProgressStreak,
      }
      void ctx.storage.set(`${GOAL_STORAGE_PREFIX}${g.sessionID}`, p as never).catch((e) => {
        log(`storage set error ${String(e)}`)
      })
    }
    function clearPersistedGoal(sessionID: string): void {
      void ctx.storage.remove(`${GOAL_STORAGE_PREFIX}${sessionID}`).catch(() => {})
    }
    function recordAchieved(g: GoalState): void {
      const a: AchievedEntry = {
        condition: g.condition,
        turns: g.turns,
        durationMs: Date.now() - g.startedAt,
        at: Date.now(),
      }
      void ctx.storage.set(`${HISTORY_STORAGE_PREFIX}${g.sessionID}`, a as never).catch(() => {})
    }
    async function loadAchieved(sessionID: string): Promise<AchievedEntry | undefined> {
      try {
        const v = (await ctx.storage.get(`${HISTORY_STORAGE_PREFIX}${sessionID}`)) as unknown as
          | AchievedEntry
          | undefined
        return v
      } catch {
        return undefined
      }
    }
    async function restoreGoals(): Promise<number> {
      let n = 0
      try {
        const res = await ctx.storage.scan({ prefix: GOAL_STORAGE_PREFIX })
        for (const entry of res.entries ?? []) {
          const key = String(entry.key)
          const sessionID = key.slice(GOAL_STORAGE_PREFIX.length)
          if (!sessionID) continue
          const raw = entry.value as unknown as PersistedGoal
          if (!raw?.condition) continue
          const g: GoalState = {
            sessionID,
            condition: raw.condition,
            turns: raw.turns ?? 0,
            maxTurns: raw.maxTurns ?? config.maxTurns,
            maxMinutes: raw.maxMinutes ?? null,
            promise: raw.promise ?? null,
            startedAt: raw.startedAt ?? Date.now(),
            phase: "paused", // 有意偏离官方：恢复不自动续跑，等用户消息或 resume
            lastReason: raw.lastReason ?? "",
            noProgressStreak: raw.noProgressStreak ?? 0,
            endedAt: null,
            restoredFromDisk: true,
          }
          G.goals.set(sessionID, g)
          n += 1
        }
      } catch (e) {
        log(`restore error ${String(e)}`)
      }
      if (n > 0) log(`restored ${n} goal(s) from storage (paused)`)
      return n
    }

    await restoreGoals()

    /** ---- 注入：synthetic + steer（实测可靠，语义干净，不伪造用户消息） ---- */
    async function inject(sessionID: string, text: string): Promise<void> {
      try {
        await ctx.session.synthetic({ sessionID, text, delivery: "steer" })
      } catch (e) {
        log(`inject error session=${sessionID}: ${String(e)}`)
      }
    }

    /** ---- 独立模型判定目标是否已满足（不调用工具、不进会话历史） ---- */
    async function evaluate(condition: string, evidence: string): Promise<EvalVerdict> {
      const prompt = [
        "你是任务完成状态评估器。只根据下面提供的条件与证据文本判断目标是否已满足。",
        "规则：",
        "- met：证据文本中出现了支撑条件成立的实际结果（命令输出、文件操作、明确完成说明）；口头宣称「我看完了」「没问题」而没有对应动作证据的不算。",
        "- not_met：条件还没有被证据支持。",
        "- impossible：条件在逻辑或物理上不可能满足（如自我矛盾、证据明确显示前提不成立），不是「暂时困难」。",
        "",
        `【目标条件】\n${condition}`,
        "",
        `【当前证据（工作模型最近 ${config.evidenceWindow} 条输出）】\n${evidence.slice(0, 6000)}`,
        "",
        '只输出一行 JSON，格式：{"verdict":"met"|"not_met"|"impossible","reason":"一句话理由（中文）"}，不要输出其它内容。',
      ].join("\n")
      try {
        const res = config.evaluatorModel
          ? await ctx.generate.text({ model: config.evaluatorModel, prompt })
          : await ctx.generate.text({ prompt })
        return extractVerdict(String(res?.text ?? ""))
      } catch (e) {
        return { verdict: "not_met", reason: `评估器调用失败：${String(e)}` }
      }
    }

    function setPhase(sessionID: string, phase: Exclude<Phase, "running">, reason: string): GoalState | undefined {
      const g = G.goals.get(sessionID)
      if (!g) return undefined
      g.phase = phase
      g.endedAt = Date.now()
      g.lastReason = reason
      if (phase === "done") recordAchieved(g)
      if (phase === "done" || phase === "failed" || phase === "cleared") clearPersistedGoal(sessionID)
      else persistGoal(g)
      return g
    }

    function pauseFor(sessionID: string, reason: string): GoalState | undefined {
      const g = G.goals.get(sessionID)
      if (!g || (g.phase !== "running" && g.phase !== "paused")) return undefined
      g.phase = "paused"
      g.lastReason = reason
      persistGoal(g)
      return g
    }

    /** ---- 预算耗尽：暂停 + 注入「总结卡点/下一步」 ---- */
    async function exhaust(sessionID: string, why: string): Promise<void> {
      const g = pauseFor(sessionID, why)
      if (!g) return
      log(`exhaust session=${sessionID} ${why}`)
      await inject(
        sessionID,
        [
          `〔/goal 已到预算上限〕${why}，目标尚未满足，已暂停并保留。`,
          `目标条件：${g.condition}`,
          "请总结：已完成什么、卡在哪、下一步怎么做（或需要什么输入）。",
          "想继续就用 /goal resume，不想继续就 /goal clear。",
        ].join("\n"),
      )
    }

    /** ---- 每轮执行结束后的处理（核心循环体） ---- */
    async function onTurnFinished(sessionID: string): Promise<void> {
      // 重入锁：同一会话并发事件不重复评估（跨实例共享，抵御重载窗口）
      if (G.evaluating.has(sessionID)) return
      G.evaluating.add(sessionID)
      try {
        const g = G.goals.get(sessionID)
        if (!g || g.phase !== "running") return
        log(`turn finished session=${sessionID} turns=${g.turns}`)

        // 时间预算
        if (g.maxMinutes && (Date.now() - g.startedAt) / 60000 >= g.maxMinutes) {
          await exhaust(sessionID, `超过时间预算 ${g.maxMinutes} 分钟`)
          return
        }
        // 轮数预算（0 = 不设限）
        if (g.maxTurns > 0 && g.turns >= g.maxTurns) {
          await exhaust(sessionID, `达到轮数上限 ${g.maxTurns} 轮`)
          return
        }

        // 读取证据（有界窗口）
        let messages: unknown[] = []
        try {
          messages = await ctx.session.context({ sessionID })
        } catch (e) {
          log(`context error ${String(e)}`)
        }
        const { texts, usedTool } = lastAssistantInfo(messages, config.evidenceWindow)
        const evidence = texts.join("\n\n---\n\n") || "（本轮没有可用的文字输出）"
        log(`evidenceLen=${evidence.length} usedTool=${usedTool}`)

        // 完成承诺快通道：模型输出了承诺串（精确包含）→ 直接判达成，省一次 evaluator 调用
        if (g.promise && evidence.includes(g.promise)) {
          log(`promise hit session=${sessionID} token=${g.promise}`)
          const done = setPhase(sessionID, "done", "完成承诺已输出")
          if (done) {
            await inject(sessionID, `✓ /goal 目标达成（完成承诺已输出）。条件：${done.condition}`)
          }
          return
        }

        // 评估
        const verdict = await evaluate(g.condition, evidence)
        g.lastReason = verdict.reason
        log(`verdict=${verdict.verdict} reason=${verdict.reason.slice(0, 200)}`)

        // 分支：达成 / 不可满足 / 继续
        if (verdict.verdict === "met") {
          const done = setPhase(sessionID, "done", "目标达成")
          if (done) {
            await inject(
              sessionID,
              `✓ /goal 目标达成。条件：${done.condition}\n评估理由：${verdict.reason}`,
            )
          }
          return
        }
        if (verdict.verdict === "impossible") {
          const failed = setPhase(sessionID, "failed", "目标无法满足")
          if (failed) {
            await inject(
              sessionID,
              `✗ /goal 判定目标不可满足，循环结束。条件：${failed.condition}\n评估理由：${verdict.reason}`,
            )
          }
          return
        }

        // not_met：无进展检测（连续若干轮没有任何工具调用）→ 暂停保留目标
        if (!usedTool) g.noProgressStreak += 1
        else g.noProgressStreak = 0
        if (g.noProgressStreak >= config.noProgressLimit) {
          const paused = pauseFor(sessionID, `连续 ${config.noProgressLimit} 轮无实际动作（无工具调用）`)
          if (paused) {
            log(`no-progress pause session=${sessionID}`)
            await inject(
              sessionID,
              [
                `⏸ /goal 已暂停：连续 ${config.noProgressLimit} 轮没有实际动作，判定无进展。目标已保留。`,
                `目标条件：${paused.condition}`,
                "想继续就用 /goal resume（或直接发消息），想结束就 /goal clear。",
              ].join("\n"),
            )
          }
          return
        }

        // 继续：注入下一轮
        g.turns += 1
        persistGoal(g)
        await inject(
          sessionID,
          [
            `〔/goal 第 ${g.turns} 轮〕继续推进，直到条件满足。`,
            `目标条件：${g.condition}`,
            `评估反馈（未满足）：${verdict.reason}`,
            g.promise ? `当且仅当条件真正满足时，单独一行输出：${g.promise}（不得为脱身谎报）。` : "",
            "请继续工作：读取文件、运行命令、修改代码均可，用可验证的证据证明条件已满足。",
            g.maxTurns > 0 ? `（本轮数上限 ${g.maxTurns} 轮）` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
      } finally {
        G.evaluating.delete(sessionID)
      }
    }

    // 事件订阅：全服务广播，按 data.sessionID 过滤 + event.id 去重（全局共享 seen）
    void (async () => {
      const controller = new AbortController()
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const ev = event as { id?: string; type?: string; data?: { sessionID?: string } }
            if (!ev.id || !ev.type) continue
            if (G.seenEvents.size > SEEN_EVENT_CAP) {
              const first = G.seenEvents.values().next().value
              if (first !== undefined) G.seenEvents.delete(first)
            }
            if (G.seenEvents.has(ev.id)) continue
            G.seenEvents.add(ev.id)

            const type = ev.type
            if (!type.startsWith("session.execution")) continue
            const sessionID = ev.data?.sessionID
            if (typeof sessionID !== "string" || !G.goals.has(sessionID)) continue
            const g = G.goals.get(sessionID)
            if (!g) continue

            if (type === "session.execution.succeeded") {
              void onTurnFinished(sessionID)
            } else if (type === "session.execution.failed") {
              // retry 钩子已处理大部分失败；这里兜底：暂停保留目标（不终态）
              if (g.phase === "running") {
                const paused = pauseFor(sessionID, "会话执行失败（可 /goal resume 或查看错误）")
                if (paused) {
                  log(`execution failed → pause session=${sessionID}`)
                  await inject(sessionID, `⚠️ /goal 已暂停：会话执行失败。条件：${g.condition}。可 /goal resume 或 /goal clear。`)
                }
              }
            } else if (type === "session.execution.interrupted") {
              log(`interrupted session=${sessionID}`)
              if (g.phase === "running") pauseFor(sessionID, "用户中断（Esc）")
            }
          } catch (e) {
            log(`event handler error ${String(e)}`)
          }
        }
      } catch (e) {
        log(`event subscribe ended ${String(e)}`)
      } finally {
        controller.abort()
      }
    })()

    // 失败分档：不可恢复错误 → 清目标（对齐 Claude /goal）
    await ctx.session
      .hook("retry", async (input) => {
        try {
          const g = G.goals.get(input.sessionID)
          if (!g || g.phase !== "running") return
          const type = String(input.error?.type ?? "")
          const message = String(input.error?.message ?? "")
          if (isUnrecoverable(type, message)) {
            input.decision = { retry: false }
            const failed = setPhase(input.sessionID, "failed", `不可恢复错误：${type || message}`)
            log(`unrecoverable error session=${input.sessionID} type=${type}`)
            if (failed) {
              await inject(
                input.sessionID,
                `✗ /goal 已停止：遇到不可恢复错误（${type || message}）。条件：${failed.condition}。修好后重新 /goal 即可。`,
              )
            }
          }
        } catch (e) {
          log(`retry hook error ${String(e)}`)
        }
      })
      .catch((e) => log(`hook retry register error ${String(e)}`))

    // 压缩保护（轻量：只增强系统生成的摘要，不接管压缩）
    await ctx.session
      .hook("compaction", async (input) => {
        try {
          const g = G.goals.get(input.sessionID)
          if (!g || g.phase !== "running") return
          if (input.result && typeof input.result.summary === "string") {
            input.result.summary = `〔/goal 进行中〕目标条件：${g.condition}；已评估 ${g.turns} 轮。\n` + input.result.summary
          }
        } catch (e) {
          log(`compaction hook error ${String(e)}`)
        }
      })
      .catch((e) => log(`hook compaction register error ${String(e)}`))

    // 命令注册
    await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "自动迭代直到条件满足（/goal <condition>）",
        execute: async (input) => {
          const sessionID = input.sessionID
          const text = (input.prompt?.text ?? "").trim()
          const existing = G.goals.get(sessionID)
          const lower = text.toLowerCase()

          // 无参数：状态
          if (text === "") {
            if (existing) {
              const achieved = await loadAchieved(sessionID)
              const lines = [
                `〔/goal 状态〕状态=${existing.phase === "running" ? "进行中" : existing.phase === "paused" ? "已暂停" : existing.phase} 已运行=${formatDuration(Date.now() - existing.startedAt)} 已评估=${existing.turns} 轮`,
                existing.restoredFromDisk ? "（此目标从磁盘恢复，已置为暂停，未自动续跑）" : "",
                `条件：${existing.condition}`,
                `最近评估：${existing.lastReason || "（尚无评估）"}`,
                existing.maxTurns > 0 ? `轮数上限：${existing.maxTurns}` : "",
                existing.maxMinutes ? `时间上限：${existing.maxMinutes} 分钟` : "",
              ].filter(Boolean)
              if (achieved) {
                lines.push(`最近一次达成（历史）：${achieved.condition}（${achieved.turns} 轮，${formatDuration(achieved.durationMs)}）`)
              }
              await inject(sessionID, lines.join("\n"))
            } else {
              const achieved = await loadAchieved(sessionID)
              await inject(
                sessionID,
                achieved
                  ? `〔/goal〕当前没有进行中的目标。最近一次达成：${achieved.condition}（${achieved.turns} 轮）。用法：/goal <条件>`
                  : "〔/goal〕当前没有进行中的目标。用法：/goal <条件>",
              )
            }
            return
          }

          // help
          if (HELP_WORDS.has(lower)) {
            await inject(
              sessionID,
              [
                "〔/goal 用法〕自动迭代直到条件满足。",
                "  /goal <条件>         启动；已有目标则直接替换",
                "  /goal                查看状态",
                "  /goal pause          暂停（保留目标）",
                "  /goal resume         恢复",
                "  /goal clear          清除（stop/off/reset/none/cancel 同义）",
                "  /goal --turns N      限制最多 N 轮（默认不设限）",
                "  /goal --mins M       限制最多 M 分钟",
                "  /goal --promise T    完成承诺串：模型输出它（精确包含）即判达成，省一次评估",
                "",
                "条件模板（六要素，按需取舍）：",
                "  ①结果：完成时什么为真（可测量）  ②验证：怎么证明（命令输出/测试结果/文件）",
                "  ③约束：途中什么不能变            ④边界：能碰哪些范围，不能碰哪些",
                "  ⑤迭代策略：每轮记录什么、下轮试什么  ⑥卡点条件：卡住时停并报告什么",
                "",
                "例：/goal 让 test/auth 全部通过，以 npm test 输出为证；不得修改其他测试文件；",
                "每轮记录失败用例与下一步尝试；若无法复现则停下报告证据与所需输入。",
                "",
                "评估由独立模型每轮完成，只依据对话中出现的证据；不要自行宣布完成。",
              ].join("\n"),
            )
            return
          }

          // pause
          if (lower === "pause") {
            if (existing && existing.phase === "running") {
              const p = pauseFor(sessionID, "用户 /goal pause")
              await inject(sessionID, `⏸ /goal 已暂停。条件：${p?.condition ?? existing.condition}。/goal resume 可恢复。`)
            } else if (existing && existing.phase === "paused") {
              await inject(sessionID, "〔/goal〕目标已处于暂停状态。")
            } else if (existing) {
              await inject(sessionID, `〔/goal〕目标已结束（状态：${existing.phase}），无法暂停。如需新目标请 /goal <条件>。`)
            } else {
              await inject(sessionID, "〔/goal〕当前没有进行中的目标。")
            }
            return
          }

          // resume
          if (lower === "resume") {
            if (existing && existing.phase === "paused") {
              existing.phase = "running"
              existing.endedAt = null
              existing.restoredFromDisk = false
              persistGoal(existing)
              log(`resume session=${sessionID}`)
              await inject(
                sessionID,
                [
                  `▶ /goal 已恢复。继续推进，直到条件满足：`,
                  existing.condition,
                  existing.promise ? `当且仅当条件真正满足时，单独一行输出：${existing.promise}（不得为脱身谎报）。` : "",
                  `最近评估：${existing.lastReason || "（尚无评估）"}`,
                ]
                  .filter(Boolean)
                  .join("\n"),
              )
            } else if (existing && existing.phase === "running") {
              await inject(sessionID, "〔/goal〕目标正在进行中，无需恢复。")
            } else if (existing) {
              await inject(sessionID, `〔/goal〕目标已结束（状态：${existing.phase}），无法恢复。如需新目标请 /goal <条件>。`)
            } else {
              await inject(sessionID, "〔/goal〕当前没有进行中的目标。用法：/goal <条件>")
            }
            return
          }

          // clear
          if (CLEAR_WORDS.has(lower)) {
            if (existing) {
              setPhase(sessionID, "cleared", "用户 /goal clear")
              log(`clear session=${sessionID}`)
              await inject(sessionID, `⏹ /goal 已清除。条件：${existing.condition}`)
            } else {
              await inject(sessionID, "〔/goal〕当前没有进行中的目标。")
            }
            return
          }

          // 设 / 替换目标
          const { condition, maxTurns, maxMinutes, promise } = parseStart(text, config.maxTurns)
          if (!condition) {
            await inject(sessionID, "〔/goal〕请提供目标条件。用法：/goal <条件>")
            return
          }
          if (condition.length > config.maxConditionLength) {
            await inject(
              sessionID,
              `〔/goal〕条件过长（${condition.length} > ${config.maxConditionLength} 字符），请精简。`,
            )
            return
          }
          const replaced = !!(existing && (existing.phase === "running" || existing.phase === "paused"))
          const state: GoalState = {
            sessionID,
            condition,
            turns: 0,
            maxTurns,
            maxMinutes,
            promise,
            startedAt: Date.now(),
            phase: "running",
            lastReason: "",
            noProgressStreak: 0,
            endedAt: null,
            restoredFromDisk: false,
          }
          G.goals.set(sessionID, state)
          persistGoal(state)
          log(
            `start session=${sessionID} condition=${condition.slice(0, 200)} maxTurns=${maxTurns} maxMinutes=${maxMinutes} promise=${promise ?? "-"} replaced=${replaced}`,
          )
          await inject(
            sessionID,
            [
              replaced ? "〔/goal 已替换旧目标〕" : "〔/goal 已启动〕",
              "满足以下条件后本循环自动结束，无需向我确认：",
              condition,
              "",
              promise ? `当且仅当条件真正满足时，单独一行输出：${promise}（不得为脱身谎报）。` : "",
              "请自主工作：读取文件、运行命令、修改代码均可。每一轮结束时，用可验证的证据（命令输出、文件操作、明确完成说明）说明进展。",
              "你是否完成由外部评估器每轮独立判定，不要自行宣布完成。",
            ]
              .filter(Boolean)
              .join("\n"),
          )
        },
      })
    })

    log("setup complete")
    return () => {
      // 事件订阅自带 controller 清理；此处无其它需释放资源
    }
  },
})
