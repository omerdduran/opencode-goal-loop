/**
 * The goal engine: parses commands, manages the continuation loop on idle,
 * applies limits/heuristics, and answers compaction/tool queries. It depends
 * only on `HostPort`, so V1 and V2 share identical behavior.
 */

import { parseCommand, type ParsedCommand } from "./command-parse.ts"
import { parseOutcome } from "./completion.ts"
import { CONTROL_MARKER } from "./constants.ts"
import { budgetLine, evaluateLimits } from "./limits.ts"
import { resolveLimits, type PluginOptions } from "./options.ts"
import {
  buildCompactionContext,
  buildContinuation,
  buildControlResult,
  buildWorkInstruction,
} from "./prompt.ts"
import { GoalStore, type CreateGoalSpec } from "./state.ts"
import { emptyUsage, type Goal, type Usage } from "./types.ts"
import type { HostMessage, HostPort } from "../ports.ts"

export interface CommandOutcome {
  /** Text to submit as the next user turn. */
  prompt: string
  /** True when the prompt is a reporting/control result (no work to do). */
  control: boolean
  /** Optional one-line notice for logging/toast. */
  notice?: string
}

export class Engine {
  readonly store: GoalStore
  private readonly idleInFlight = new Set<string>()
  private readonly options: PluginOptions
  private readonly host: HostPort

  constructor(options: PluginOptions, host: HostPort) {
    this.options = options
    this.host = host
    this.store = new GoalStore(options)
  }

  private now(): number {
    return this.host.now()
  }

  private isRestricted(agent: string | undefined): boolean {
    if (this.options.allowGoalExecutionFromPlan) return false
    if (!agent) return false
    const a = agent.toLowerCase()
    return this.options.restrictedAgents.some((r) => r.toLowerCase() === a)
  }

  private usageFrom(msg: HostMessage | undefined): Usage {
    const u = msg?.usage
    if (!u) return emptyUsage()
    return {
      input: u.input ?? 0,
      output: u.output ?? 0,
      reasoning: u.reasoning ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      cost: typeof u.cost === "number" ? u.cost : 0,
      costKnown: typeof u.cost === "number",
    }
  }

  // ---- command handling -------------------------------------------------

  async runCommand(sessionID: string, args: string, agentHint?: string): Promise<CommandOutcome> {
    const outcome = await this.runCommandInner(sessionID, args, agentHint)
    await this.refreshTitle(sessionID)
    return outcome
  }

  private async runCommandInner(
    sessionID: string,
    args: string,
    agentHint?: string,
  ): Promise<CommandOutcome> {
    const cmd = parseCommand(args)
    const now = this.now()

    switch (cmd.action) {
      case "status":
        return this.control(this.statusText(sessionID))
      case "history":
        return this.control(this.historyText(sessionID))
      case "list":
        return this.control(this.listText(sessionID))
      case "clear":
        this.store.clear(sessionID)
        return this.control("Goal cleared for this session.")
      case "pause": {
        const goal = this.store.pause(sessionID, "user requested pause", now)
        return this.control(goal ? "Goal paused." : "No active goal to pause.")
      }
      case "resume": {
        const goal = this.store.resume(sessionID, now)
        if (!goal) return this.control("No paused goal or achieved goal to resume.")
        if (this.isRestricted(goal.agent)) {
          return this.control("Goal resumed, but the active agent is restricted; it will be held.")
        }
        return this.control("Goal resumed with a fresh budget window.")
      }
      case "focus": {
        if (cmd.focusIndex === undefined) return this.control("Usage: /goal focus <number>")
        const goal = this.store.focus(sessionID, cmd.focusIndex)
        return this.control(
          goal ? `Focused goal ${cmd.focusIndex}: ${goal.condition}` : "No goal at that index.",
        )
      }
      case "edit": {
        if (!cmd.objective) return this.control("Usage: /goal edit <new objective>")
        const goal = this.store.edit(sessionID, cmd.objective, now)
        return this.control(goal ? `Objective updated: ${goal.condition}` : "No active goal to edit.")
      }
      case "sequence": {
        if (cmd.sequence.length === 0) return this.control("Usage: /goal sequence a; b; c")
        const created = this.store.sequence(sessionID, cmd.sequence, this.specFrom(cmd, agentHint), now)
        const first = created[0]
        if (!first) return this.control("No goals created.")
        return {
          prompt: buildWorkInstruction(first),
          control: false,
          notice: `Sequence started (${created.length} goals).`,
        }
      }
      default:
        break
    }

    if (cmd.error) return this.control(`Command error: ${cmd.error}`)

    const objective = cmd.objective.trim()
    if (!objective) return this.control("Usage: /goal <objective> [flags]")

    if (cmd.action === "add") {
      const current = this.store.focused(sessionID)
      if (current) {
        current.focused = false
        this.store.session(sessionID).focusedGoalID = null
      }
      const goal = this.store.create(sessionID, this.specFrom(cmd, agentHint), now)
      return { prompt: buildWorkInstruction(goal), control: false, notice: `Added goal: ${goal.condition}` }
    }

    // Default: set (replace focused).
    const goal = this.store.create(sessionID, this.specFrom(cmd, agentHint), now)
    if (this.isRestricted(goal.agent)) {
      goal.status = "paused"
      goal.stopped = true
      goal.stopReason = "plan agent active"
      this.store.pushHistory(goal, "held", "plan agent active", now)
    }
    return { prompt: buildWorkInstruction(goal), control: false, notice: `Goal set: ${goal.condition}` }
  }

  private specFrom(cmd: ParsedCommand, agentHint?: string): CreateGoalSpec {
    const spec: CreateGoalSpec = {
      condition: cmd.objective,
      successCriteria: cmd.successCriteria,
      constraints: cmd.constraints,
      limits: cmd.limits,
    }
    if (cmd.mode !== undefined) spec.mode = cmd.mode
    if (agentHint !== undefined) spec.agent = agentHint
    return spec
  }

  private control(text: string): CommandOutcome {
    return { prompt: buildControlResult(text), control: true }
  }

  // ---- message/agent tracking ------------------------------------------

  noteAgent(
    sessionID: string,
    agent?: string,
    model?: { providerID: string; modelID: string },
    variant?: string,
  ): void {
    const goal = this.store.focused(sessionID)
    if (!goal) return
    if (agent && !goal.agent) goal.agent = agent
    if (model && !goal.model) goal.model = model
    if (variant && !goal.variant) goal.variant = variant
  }

  /** Hold (pause) an active goal when it is running under a restricted agent. */
  applyAgentHold(sessionID: string, agent?: string): void {
    const goal = this.store.focused(sessionID)
    if (!goal || goal.status !== "active") return
    if (!this.isRestricted(agent)) return
    goal.status = "paused"
    goal.stopped = true
    goal.stopReason = "plan agent active"
    goal.updatedAt = this.now()
    this.store.pushHistory(goal, "held", "plan agent active", this.now())
  }

  // ---- idle continuation -----------------------------------------------

  async onIdle(sessionID: string): Promise<void> {
    if (this.idleInFlight.has(sessionID)) return
    this.idleInFlight.add(sessionID)
    try {
      await this.runIdle(sessionID)
    } catch (err) {
      await this.host.log("error", "goal idle handler failed", { error: String(err) })
    } finally {
      this.idleInFlight.delete(sessionID)
    }
  }

  private async runIdle(sessionID: string): Promise<void> {
    const goal = this.store.focused(sessionID)
    if (!goal || goal.status !== "active" || goal.stopped) return
    if (this.isRestricted(goal.agent)) return

    if (this.options.noContinueWhileChildrenActive && this.host.listChildren) {
      try {
        const children = await this.host.listChildren(sessionID)
        if (children.some((c) => c.active)) {
          await this.notice(sessionID, "Goal deferred: child sessions active")
          return
        }
      } catch {
        // fail open
      }
    }

    const now = this.now()
    const messages = await this.host.readRecentMessages(sessionID, this.options.maxRecentMessages)
    if (messages.length === 0) return

    if (!this.options.noInterruptOnUserMessage && this.hasHumanIntervention(messages, goal)) {
      this.store.pause(sessionID, "user intervention", now)
      await this.notice(sessionID, "Goal paused: user intervention")
      return
    }

    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
    if (!lastAssistant) return

    this.store.applyUsage(goal, this.usageFrom(lastAssistant))

    const outcome = parseOutcome(lastAssistant.text)
    if (outcome.kind === "complete") {
      await this.handleComplete(sessionID, goal, outcome.evidence)
      return
    }
    if (outcome.kind === "blocked") {
      this.store.block(sessionID, outcome.blocker, now)
      await this.notice(sessionID, `Goal paused as blocked: ${outcome.blocker.slice(0, 120)}`)
      return
    }

    // Analyze each assistant turn exactly once, so repeated idle events for the
    // same turn do not inflate the stall counters or duplicate checkpoints.
    // Responses to plugin control commands (status/history/...) are excluded.
    const alreadyAnalyzed =
      lastAssistant.id.length > 0 && goal.lastAnalyzedMessageID === lastAssistant.id
    const controlTurn = this.precededByControl(messages, lastAssistant.id)
    if (!alreadyAnalyzed && !controlTurn) {
      if (lastAssistant.id.length > 0) goal.lastAnalyzedMessageID = lastAssistant.id
      this.recordCheckpoint(goal, lastAssistant.text, now)
      this.updateStreaks(goal, lastAssistant, this.options.noProgressTokenThreshold)
    }

    const limits = evaluateLimits(goal, this.options, now)
    const effective = resolveLimits(this.options, goal)

    if (effective.noProgressTurnsBeforePause > 0 && goal.noProgressStreak >= effective.noProgressTurnsBeforePause) {
      this.store.pause(sessionID, "no progress", now)
      await this.notice(sessionID, "Goal paused: no progress")
      return
    }
    if (effective.noToolCallTurnsBeforePause > 0 && goal.noToolCallStreak >= effective.noToolCallTurnsBeforePause) {
      this.store.pause(sessionID, "no tool calls", now)
      await this.notice(sessionID, "Goal paused: repeated tool-free turns")
      return
    }

    if (limits.exhausted) {
      if (!goal.wrapupSent) {
        goal.wrapupSent = true
        await this.sendContinuation(sessionID, goal, lastAssistant, now, limits.warnings)
      } else {
        this.store.pause(sessionID, limits.reason, now)
        await this.notice(sessionID, `Goal stopped: ${limits.reason}`)
      }
      return
    }

    if (lastAssistant.id && goal.lastContinuedMessageID === lastAssistant.id) return
    if (now - goal.lastContinueAt < effective.minDelayMs) return

    const nudges: string[] = []
    if (outcome.kind === "invalid-complete") {
      nudges.push(
        "Your previous message claimed completion without adjacent evidence. Provide a [goal:evidence] line with concrete verification, or keep working.",
      )
    }
    if (outcome.kind === "invalid-blocked") {
      nudges.push(
        "Your previous message used the blocked marker without stating a concrete blocker. State the specific blocker, or keep working.",
      )
    }

    if (limits.shouldWrapup) goal.wrapupSent = true
    await this.sendContinuation(sessionID, goal, lastAssistant, now, [...limits.warnings, ...nudges])
  }

  private precededByControl(messages: HostMessage[], assistantId: string): boolean {
    const ai = messages.findIndex((m) => m.id === assistantId)
    if (ai < 0) return false
    for (let i = ai - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role === "user") {
        return m.pluginOwned && m.text.trimStart().startsWith(CONTROL_MARKER)
      }
    }
    return false
  }

  private hasHumanIntervention(messages: HostMessage[], goal: Goal): boolean {
    let startIdx = 0
    if (goal.lastContinuedMessageID) {
      const idx = messages.findIndex((m) => m.id === goal.lastContinuedMessageID)
      // If the boundary turn is not in the (truncated) window, we cannot tell
      // whether a message superseded the loop, so do not pause.
      if (idx < 0) return false
      startIdx = idx + 1
    }
    for (let i = startIdx; i < messages.length; i++) {
      const m = messages[i]!
      if (m.role === "user" && !m.pluginOwned) return true
    }
    return false
  }

  private updateStreaks(goal: Goal, msg: HostMessage, threshold: number): void {
    const out = msg.usage?.output ?? 0
    if (msg.usage && out < threshold) goal.noProgressStreak += 1
    else goal.noProgressStreak = 0

    if (msg.hasToolCalls) goal.noToolCallStreak = 0
    else goal.noToolCallStreak += 1
  }

  private recordCheckpoint(goal: Goal, text: string, now: number): void {
    const summary = summarize(text)
    if (summary.length === 0) return
    goal.lastCheckpoint = { summary, timestamp: now }
    goal.checkpoints.push({ summary, timestamp: now })
    if (goal.checkpoints.length > 20) goal.checkpoints.splice(0, goal.checkpoints.length - 20)
  }

  private async sendContinuation(
    sessionID: string,
    goal: Goal,
    source: HostMessage,
    now: number,
    warnings: string[],
  ): Promise<void> {
    const text = buildContinuation(goal, this.options, now, warnings)
    try {
      await this.host.sendPrompt({
        sessionID,
        text,
        ...(goal.agent !== undefined ? { agent: goal.agent } : {}),
        ...(goal.model !== undefined ? { model: goal.model } : {}),
        ...(goal.variant !== undefined ? { variant: goal.variant } : {}),
      })
    } catch (err) {
      goal.consecutiveFailures += 1
      await this.host.log("warn", "goal continuation failed", { error: String(err) })
      if (goal.consecutiveFailures >= this.options.maxPromptFailures) {
        this.store.pause(sessionID, "repeated continuation failures", now)
        await this.notice(sessionID, "Goal paused: repeated continuation failures")
      }
      return
    }
    // Only count the turn and claim the source turn after a successful send, so
    // a failed continuation can be retried on a later idle.
    goal.lastContinuedMessageID = source.id
    goal.lastContinueAt = now
    goal.turnCount += 1
    goal.consecutiveFailures = 0
    goal.updatedAt = now
    this.store.pushHistory(goal, "continue", `turn ${goal.turnCount}`, now)
  }

  private async handleComplete(sessionID: string, goal: Goal, evidence: string): Promise<void> {
    const now = this.now()
    if (this.options.auditor) {
      try {
        const verdict = await this.options.auditor({ goal, sessionID, latestText: evidence })
        if (!verdict.approved) {
          this.store.pause(sessionID, `audit rejected: ${verdict.reason ?? "no reason"}`, now)
          await this.notice(sessionID, `Completion rejected by auditor: ${verdict.reason ?? ""}`)
          return
        }
      } catch (err) {
        this.store.pause(sessionID, "audit error", now)
        await this.host.log("error", "completion auditor threw", { error: String(err) })
        return
      }
    }
    const archived = this.store.complete(sessionID, evidence, now)
    await this.notice(sessionID, `Goal complete: ${archived?.condition ?? ""}`)
    const state = this.store.session(sessionID)
    if (state.ordered && state.goals.some((g) => !g.focused)) {
      const next = this.store.promoteNext(sessionID, now)
      if (next) await this.notice(sessionID, `Next goal: ${next.condition}`)
    }
  }

  // ---- compaction -------------------------------------------------------

  compactionContext(sessionID: string): string | undefined {
    const goal = this.store.focused(sessionID)
    if (!goal || goal.status === "achieved") return undefined
    return buildCompactionContext(goal, this.options, this.now())
  }

  /** A concise active-goal block injected into every model request (V2). */
  activeGoalBlock(sessionID: string): string | undefined {
    const goal = this.store.focused(sessionID)
    if (!goal || goal.status === "achieved") return undefined
    return `## Active goal (opencode-goal-loop)
Objective: ${goal.condition}
Status: ${goal.status}
Keep working toward this objective until it is done. Finish with a "[goal:evidence] <verification>" line then "[goal:complete]", or state the concrete blocker then "[goal:blocked]".`
  }

  shouldAutoContinueAfterCompaction(sessionID: string): boolean {
    const goal = this.store.focused(sessionID)
    if (!goal || goal.status !== "active" || goal.stopped) return true
    return false
  }

  // ---- tool-facing API --------------------------------------------------

  setGoalFromTool(sessionID: string, condition: string, agentHint?: string): Goal | undefined {
    if (!condition.trim()) return undefined
    return this.store.create(
      sessionID,
      { condition: condition.trim(), ...(agentHint ? { agent: agentHint } : {}) },
      this.now(),
    )
  }

  pauseGoal(sessionID: string, reason = "tool pause"): Goal | undefined {
    return this.store.pause(sessionID, reason, this.now())
  }

  resumeGoal(sessionID: string): Goal | undefined {
    return this.store.resume(sessionID, this.now())
  }

  blockGoal(sessionID: string, reason: string): Goal | undefined {
    return this.store.block(sessionID, reason, this.now())
  }

  completeGoal(sessionID: string, evidence: string): Goal | undefined {
    return this.store.complete(sessionID, evidence, this.now())
  }

  statusText(sessionID: string): string {
    const state = this.store.session(sessionID)
    const goal = this.store.focused(sessionID)
    const lines: string[] = []
    if (!goal) {
      lines.push("No active goal.")
    } else {
      lines.push(`Active goal: ${goal.condition}`)
      lines.push(`State: ${goal.status}`)
      lines.push(`Budget: ${budgetLine(goal, this.options, this.now())}`)
      if (goal.successCriteria) lines.push(`Success criteria: ${goal.successCriteria}`)
      if (goal.constraints) lines.push(`Constraints: ${goal.constraints}`)
      if (goal.blockedReason) lines.push(`Blocker: ${goal.blockedReason}`)
      if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`)
      if (goal.evidence) lines.push(`Evidence: ${goal.evidence}`)
      if (goal.lastCheckpoint) lines.push(`Last checkpoint: ${goal.lastCheckpoint.summary}`)
    }
    const archived = state.archived.slice(-3)
    if (archived.length > 0) {
      lines.push("")
      lines.push("Recent completed goals:")
      for (const a of archived) {
        lines.push(`- ${a.condition} (${a.turnCount} turns${a.evidence ? `: ${a.evidence}` : ""})`)
      }
    }
    return lines.join("\n")
  }

  private listText(sessionID: string): string {
    const state = this.store.session(sessionID)
    if (state.goals.length === 0) return "No live goals."
    const lines = state.goals.map((g, i) => {
      const mark = g.focused ? "*" : " "
      return `${i + 1}.${mark} [${g.status}] ${g.condition}`
    })
    return `Live goals${state.ordered ? " (ordered)" : ""}:\n${lines.join("\n")}`
  }

  private historyText(sessionID: string): string {
    const goal = this.store.focused(sessionID)
    if (!goal) return "No active goal."
    const lines = [`History for: ${goal.condition}`]
    for (const h of goal.history.slice(-20)) lines.push(`- ${h.type}: ${h.detail}`)
    if (goal.lastCheckpoint) lines.push(`Latest checkpoint: ${goal.lastCheckpoint.summary}`)
    return lines.join("\n")
  }

  private async notice(sessionID: string, text: string): Promise<void> {
    await this.refreshTitle(sessionID)
    if (!this.options.lifecycleMessages) return
    await this.host.log("info", `[goal-loop] ${text}`, { sessionID })
    await this.host.toast(text, "info")
  }

  /** Mirror live goal status into the session title (opt-in, cosmetic). */
  private async refreshTitle(sessionID: string): Promise<void> {
    if (!this.options.sessionTitleStatus || !this.host.setTitle) return
    const goal = this.store.focused(sessionID)
    if (!goal) return
    const icon =
      goal.status === "achieved" ? "✅" : goal.status === "blocked" ? "⛔" : goal.status === "paused" ? "⏸" : "▶"
    const limits = resolveLimits(this.options, goal)
    const mins = Math.floor(Math.max(0, this.now() - goal.startedAt) / 60_000)
    const title = `${icon} ${goal.condition} · ${goal.turnCount}/${limits.maxTurns} · ${mins}m · ${goal.totalTokens}/${limits.maxTokens}`
    try {
      await this.host.setTitle(sessionID, title)
    } catch {
      // cosmetic only
    }
  }
}

function summarize(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean
}
