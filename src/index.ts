/**
 * opencode-goal — 直到条件满足的自动迭代循环
 *
 * 这是 Claude Code `/goal`（目标型循环）在 OpenCode V2 上的开源实现。
 *
 * 机制：
 *  - 每轮会话执行结束（session.execution.succeeded）后，用独立模型（evaluator）
 *    读取目标条件 + 工作模型最近输出，判定三态：
 *      met        → 循环成功结束
 *      not_met    → 继续：把评估理由作为下一轮指引注入会话
 *      impossible → 条件无法满足，循环失败结束
 *  - evaluator 通过 ctx.generate.text 调用：不创建会话、不调用工具、不进会话历史。
 *  - 护栏：轮数上限（默认 10，--turns N）、时间上限（--mins M）、
 *          连续无工具轮数达上限（默认 3）判为无进展并停止。
 *  - 用户中断（session.execution.interrupted）或 /goal stop 立即停止。
 *
 * 命令：
 *  /goal <condition>                 启动
 *  /goal                             查看状态
 *  /goal stop|clear|cancel|off      停止
 *  /goal help                        说明
 *
 * 配置（优先级：plugin options > ~/.config/opencode-goal.json > 环境变量）：
 *    evaluatorModel  评估器模型 { "providerID": "...", "id": "..." }；缺省则不指定模型
 *    maxTurns        轮数上限，默认 10
 *    noProgressLimit 连续无工具轮数上限，默认 3
 *    logFile         日志路径，默认 ~/.local/state/opencode-goal/goal.log；"off" 关闭
 *  环境变量：OPENCODE_GOAL_EVALUATOR_MODEL="providerID/modelID"、OPENCODE_GOAL_LOG_FILE
 */
import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** ---- 常量 ---- */
const PLUGIN_ID = "opencode-goal"
const DEFAULT_MAX_TURNS = 10
const DEFAULT_NO_PROGRESS_LIMIT = 3
const SEEN_EVENT_CAP = 4000
const CONFIG_PATH = join(homedir(), ".config", "opencode-goal.json")
const DEFAULT_LOG_FILE = join(homedir(), ".local", "state", "opencode-goal", "goal.log")

/** ---- 配置 ---- */
interface ModelRef {
  providerID: string
  id: string
}

interface GoalConfig {
  evaluatorModel: ModelRef | undefined
  maxTurns: number
  noProgressLimit: number
  logFile: string | null
}

function asModelRef(v: unknown): ModelRef | undefined {
  if (!v || typeof v !== "object") return undefined
  const o = v as Record<string, unknown>
  if (typeof o.providerID !== "string" || typeof o.id !== "string") return undefined
  return { providerID: o.providerID, id: o.id }
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

/** ---- 类型 ---- */
type Phase = "running" | "done" | "failed" | "exhausted" | "stopped"

interface GoalState {
  sessionID: string
  condition: string
  turns: number // 已注入的迭代轮数
  maxTurns: number
  maxMinutes: number | null
  startedAt: number
  phase: Phase
  lastReason: string
  noProgressStreak: number
  endedAt: number | null
}

interface EvalVerdict {
  verdict: "met" | "not_met" | "impossible"
  reason: string
}

/** assistant 会话消息的实际形状（实测自 OpenCode V2 session.context） */
interface AssistantMsg {
  type?: string
  time?: { completed?: number }
  content?: Array<{ type?: string; text?: string }>
}

const STOP_WORDS = new Set(["stop", "clear", "cancel", "off", "reset", "none", "abort"])
const HELP_WORDS = new Set(["help", "h", "?"])

/** ---- 纯函数 ---- */
function parseStart(
  text: string,
  defaultMaxTurns: number,
): { condition: string; maxTurns: number; maxMinutes: number | null } {
  let t = text.trim()
  let maxTurns = defaultMaxTurns
  let maxMinutes: number | null = null
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
  return { condition: t.trim(), maxTurns, maxMinutes }
}

/** 取最近若干条 assistant 消息的正文，并判断最近一轮是否调用了工具 */
function lastAssistantInfo(messages: unknown[], count = 2): { texts: string[]; usedTool: boolean } {
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

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = resolveConfig((ctx as { options?: unknown }).options)
    const log = makeLogger(config.logFile)
    const modelLabel = config.evaluatorModel
      ? `${config.evaluatorModel.providerID}/${config.evaluatorModel.id}`
      : "(未指定，使用 OpenCode 默认)"
    log(`setup begin evaluator=${modelLabel} maxTurns=${config.maxTurns} noProgressLimit=${config.noProgressLimit}`)

    const goals = new Map<string, GoalState>()
    const seenEvents = new Set<string>()
    const controller = new AbortController()

    /**
     * 向会话注入信息（nudge / 结论 / 状态）。
     * 用 session.prompt（用户输入语义，delivery=steer）而非 session.synthetic：
     * synthetic 在会话 idle 时入队 inbox 存在不被立即拉取的窗口（实测会滞留在队列，
     * 直到下一次外部消息才被消费），prompt 则总是立即触发执行，保证循环可靠推进。
     */
    async function inject(sessionID: string, text: string): Promise<void> {
      try {
        await ctx.session.prompt({ sessionID, text, delivery: "steer" })
      } catch (e) {
        log(`inject error session=${sessionID}: ${String(e)}`)
      }
    }

    /** 独立模型判定目标是否已满足（不调用工具、不进会话历史） */
    async function evaluate(condition: string, evidence: string): Promise<EvalVerdict> {
      const prompt = [
        "你是任务完成状态评估器。只根据下面提供的条件与证据文本判断目标是否已满足。",
        "规则：",
        "- met：证据文本中出现了支撑条件成立的实际结果（命令输出、文件操作、明确完成说明）；口头宣称「我看完了」「没问题」而没有对应动作证据的不算。",
        "- not_met：条件还没有被证据支持。",
        "- impossible：条件在逻辑或物理上不可能满足（如自我矛盾）。",
        "",
        `【目标条件】\n${condition}`,
        "",
        `【当前证据（工作模型最近一轮的输出）】\n${evidence.slice(0, 6000)}`,
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

    function finish(sessionID: string, phase: Exclude<Phase, "running">, reason: string): void {
      const g = goals.get(sessionID)
      if (!g) return
      g.phase = phase
      g.endedAt = Date.now()
      g.lastReason = reason
    }

    /** 每轮执行结束后的处理（核心循环体） */
    async function onTurnFinished(sessionID: string): Promise<void> {
      const g = goals.get(sessionID)
      if (!g || g.phase !== "running") return
      log(`turn finished session=${sessionID} turns=${g.turns}`)

      // 时间预算
      if (g.maxMinutes && (Date.now() - g.startedAt) / 60000 >= g.maxMinutes) {
        finish(sessionID, "exhausted", `超过时间预算 ${g.maxMinutes} 分钟`)
        await inject(sessionID, `〔/goal 已停止〕超时（${g.maxMinutes} 分钟）。条件：${g.condition}`)
        return
      }

      // 轮数预算
      if (g.turns >= g.maxTurns) {
        finish(sessionID, "exhausted", `达到轮数上限 ${g.maxTurns}`)
        await inject(
          sessionID,
          `〔/goal 已停止〕达到轮数上限 ${g.maxTurns} 轮仍未满足条件。最近评估理由：${g.lastReason}`,
        )
        return
      }

      // 读取证据
      let messages: unknown[] = []
      try {
        messages = await ctx.session.context({ sessionID })
      } catch (e) {
        log(`context error ${String(e)}`)
      }
      const { texts, usedTool } = lastAssistantInfo(messages)
      const evidence = texts.join("\n\n---\n\n") || "（本轮没有可用的文字输出）"
      log(`evidenceLen=${evidence.length} usedTool=${usedTool}`)

      // 评估
      const verdict = await evaluate(g.condition, evidence)
      g.lastReason = verdict.reason
      log(`verdict=${verdict.verdict} reason=${verdict.reason.slice(0, 200)}`)

      // 分支：达成 / 不可满足 / 继续
      if (verdict.verdict === "met") {
        finish(sessionID, "done", "目标达成")
        await inject(sessionID, `✓ /goal 目标达成。条件：${g.condition}\n评估理由：${verdict.reason}`)
        return
      }
      if (verdict.verdict === "impossible") {
        finish(sessionID, "failed", "目标无法满足")
        await inject(
          sessionID,
          `✗ /goal 判定目标不可满足，循环结束。条件：${g.condition}\n评估理由：${verdict.reason}`,
        )
        return
      }

      // not_met：无进展检测（连续若干轮没有任何工具调用）
      if (!usedTool) g.noProgressStreak += 1
      else g.noProgressStreak = 0
      if (g.noProgressStreak >= config.noProgressLimit) {
        finish(sessionID, "stopped", `连续 ${config.noProgressLimit} 轮无实际动作（无工具调用）`)
        await inject(
          sessionID,
          `⏸ /goal 已停止：连续 ${config.noProgressLimit} 轮没有实际动作，判定无进展。条件：${g.condition}`,
        )
        return
      }

      // 继续：注入下一轮
      g.turns += 1
      await inject(
        sessionID,
        [
          `〔/goal 第 ${g.turns}/${g.maxTurns} 轮〕继续推进，直到条件满足。`,
          `目标条件：${g.condition}`,
          `评估反馈（未满足）：${verdict.reason}`,
          "请继续工作：读取文件、运行命令、修改代码均可，用可验证的证据证明条件已满足。",
        ].join("\n"),
      )
    }

    // 事件订阅：全服务广播，按 data.sessionID 过滤 + event.id 去重
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const ev = event as { id?: string; type?: string; data?: { sessionID?: string } }
          if (!ev.id || !ev.type) continue
          if (seenEvents.size > SEEN_EVENT_CAP) {
            const first = seenEvents.values().next().value
            if (first !== undefined) seenEvents.delete(first)
          }
          if (seenEvents.has(ev.id)) continue
          seenEvents.add(ev.id)

          const type = ev.type
          if (!type.startsWith("session.execution")) continue
          const sessionID = ev.data?.sessionID
          if (typeof sessionID !== "string" || !goals.has(sessionID)) continue
          const g = goals.get(sessionID)
          if (!g || g.phase !== "running") continue

          if (type === "session.execution.succeeded") {
            void onTurnFinished(sessionID)
          } else if (type === "session.execution.failed") {
            finish(sessionID, "failed", "执行失败（execution.failed）")
            await inject(sessionID, `✗ /goal 已停止：会话执行失败。条件：${g.condition}`)
          } else if (type === "session.execution.interrupted") {
            log(`interrupted session=${sessionID}`)
            finish(sessionID, "stopped", "用户中断（Esc）")
          }
        } catch (e) {
          log(`event handler error ${String(e)}`)
        }
      }
    })()

    // 命令注册
    await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "自动迭代直到条件满足（/goal <condition>）",
        execute: async (input) => {
          const sessionID = input.sessionID
          const text = (input.prompt?.text ?? "").trim()
          const existing = goals.get(sessionID)

          // 无参数：状态
          if (text === "") {
            await inject(
              sessionID,
              existing
                ? `〔/goal 状态〕phase=${existing.phase} 轮次=${existing.turns}/${existing.maxTurns} 起始=${new Date(
                    existing.startedAt,
                  ).toISOString()}\n条件：${existing.condition}\n最近评估：${existing.lastReason}`
                : "〔/goal〕当前没有进行中的目标。用法：/goal <条件>",
            )
            return
          }
          const lower = text.toLowerCase()

          // help
          if (HELP_WORDS.has(lower)) {
            await inject(
              sessionID,
              [
                "〔/goal 用法〕自动迭代直到条件满足。",
                "  /goal <条件>         启动（如：/goal 所有测试通过 或 /goal npm test 退出码为 0）",
                "  /goal                查看状态",
                "  /goal stop           停止",
                "  /goal --turns 5      限制最多 5 轮",
                "  /goal --mins 30      限制最多 30 分钟",
                "条件三要素建议：① 一个可测量的终态（测试结果/退出码/文件存在/队列空）② 明确的检查方式（npm test 退出 0 / git status 干净）③ 途中不可变的约束。",
                "评估由独立模型每轮完成，只依据对话中出现的证据。",
              ].join("\n"),
            )
            return
          }

          // stop
          if (STOP_WORDS.has(lower)) {
            if (existing && existing.phase === "running") {
              finish(sessionID, "stopped", "用户 /goal stop")
              await inject(sessionID, `⏹ /goal 已停止。条件：${existing.condition}`)
            } else {
              await inject(sessionID, "〔/goal〕当前没有进行中的目标。")
            }
            return
          }

          // 启动
          if (existing && existing.phase === "running") {
            await inject(
              sessionID,
              `〔/goal〕已有进行中的目标（${existing.turns}/${existing.maxTurns} 轮）。先用 /goal stop 停止，或等待其结束。`,
            )
            return
          }
          const { condition, maxTurns, maxMinutes } = parseStart(text, config.maxTurns)
          if (!condition) {
            await inject(sessionID, "〔/goal〕请提供目标条件。用法：/goal <条件>")
            return
          }
          const state: GoalState = {
            sessionID,
            condition,
            turns: 0,
            maxTurns,
            maxMinutes,
            startedAt: Date.now(),
            phase: "running",
            lastReason: "",
            noProgressStreak: 0,
            endedAt: null,
          }
          goals.set(sessionID, state)
          log(
            `start session=${sessionID} condition=${condition.slice(0, 200)} maxTurns=${maxTurns} maxMinutes=${maxMinutes}`,
          )
          await inject(
            sessionID,
            [
              "〔/goal 已启动〕满足以下条件后本循环自动结束，无需向我确认：",
              condition,
              "",
              "请自主工作：读取文件、运行命令、修改代码均可。每一轮结束时，用可验证的证据（命令输出、文件操作、明确完成说明）说明进展。",
              "你是否完成由外部评估器每轮独立判定，不要自行宣布完成。",
            ].join("\n"),
          )
        },
      })
    })

    log("setup complete")
    return () => controller.abort()
  },
})
