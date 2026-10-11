/**
 * In-memory goal store. Persistence is handled by adapters via serialize/load.
 */

import { randomUUID } from "node:crypto"
import type { PluginOptions } from "./options.ts"
import {
  emptySessionState,
  emptyUsage,
  type ArchivedGoal,
  type Goal,
  type GoalMode,
  type SessionState,
  type Usage,
} from "./types.ts"
import type { LimitOverrides } from "./types.ts"

export interface CreateGoalSpec {
  condition: string
  successCriteria?: string
  constraints?: string
  mode?: GoalMode
  limits?: Partial<LimitOverrides>
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  background?: boolean
}

export interface StoreSnapshot {
  version: 1
  sessions: Record<string, SessionState>
}

function makeGoal(sessionID: string, spec: CreateGoalSpec, now: number): Goal {
  return {
    id: randomUUID(),
    sessionID,
    condition: spec.condition,
    successCriteria: spec.successCriteria ?? "",
    constraints: spec.constraints ?? "",
    mode: spec.mode ?? "normal",
    status: "active",
    focused: false,
    turnCount: 0,
    startedAt: now,
    pausedAt: null,
    updatedAt: now,
    totalTokens: 0,
    usage: emptyUsage(),
    ...(spec.agent !== undefined ? { agent: spec.agent } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.variant !== undefined ? { variant: spec.variant } : {}),
    lastCheckpoint: null,
    checkpoints: [],
    history: [],
    stopped: false,
    stopReason: "",
    blockedReason: "",
    evidence: "",
    limits: spec.limits ?? {},
    lastContinuedMessageID: "",
    lastAnalyzedMessageID: "",
    lastContinueAt: 0,
    noProgressStreak: 0,
    noToolCallStreak: 0,
    consecutiveFailures: 0,
    wrapupSent: false,
  }
}

export class GoalStore {
  private sessions = new Map<string, SessionState>()
  private readonly options: PluginOptions

  constructor(options: PluginOptions) {
    this.options = options
  }

  session(sessionID: string): SessionState {
    let s = this.sessions.get(sessionID)
    if (!s) {
      s = emptySessionState(sessionID)
      this.sessions.set(sessionID, s)
    }
    return s
  }

  focused(sessionID: string): Goal | undefined {
    const s = this.session(sessionID)
    if (!s.focusedGoalID) return undefined
    return s.goals.find((g) => g.id === s.focusedGoalID)
  }

  all(sessionID: string): Goal[] {
    return this.session(sessionID).goals
  }

  pushHistory(goal: Goal, type: string, detail: string, now: number): void {
    goal.history.push({ type, detail, timestamp: now })
    if (goal.history.length > 50) goal.history.splice(0, goal.history.length - 50)
  }

  private backgroundFocused(state: SessionState): void {
    for (const g of state.goals) g.focused = false
  }

  create(sessionID: string, spec: CreateGoalSpec, now: number): Goal {
    const state = this.session(sessionID)
    const goal = makeGoal(sessionID, spec, now)
    if (spec.background) {
      state.goals.push(goal)
    } else {
      // Replace the focused goal (the previous one is retained, backgrounded).
      this.backgroundFocused(state)
      goal.focused = true
      state.goals.push(goal)
      state.focusedGoalID = goal.id
    }
    this.pushHistory(goal, "created", spec.condition, now)
    return goal
  }

  focus(sessionID: string, index1: number): Goal | undefined {
    const state = this.session(sessionID)
    const target = state.goals[index1 - 1]
    if (!target) return undefined
    this.backgroundFocused(state)
    target.focused = true
    state.focusedGoalID = target.id
    if (target.status === "paused") {
      target.status = "active"
      target.pausedAt = null
      target.stopped = false
      target.stopReason = ""
    }
    // Clear the continuation claim so the freshly focused goal can continue.
    target.lastContinuedMessageID = ""
    return target
  }

  edit(sessionID: string, condition: string, now: number): Goal | undefined {
    const goal = this.focused(sessionID)
    if (!goal) return undefined
    goal.condition = condition
    goal.status = "active"
    goal.pausedAt = null
    goal.stopped = false
    goal.stopReason = ""
    goal.blockedReason = ""
    goal.wrapupSent = false
    goal.lastContinuedMessageID = ""
    goal.updatedAt = now
    this.pushHistory(goal, "edited", condition, now)
    return goal
  }

  pause(sessionID: string, reason: string, now: number): Goal | undefined {
    const goal = this.focused(sessionID)
    if (!goal) return undefined
    goal.status = "paused"
    goal.stopped = true
    goal.stopReason = reason
    goal.pausedAt = now
    goal.updatedAt = now
    this.pushHistory(goal, "paused", reason, now)
    return goal
  }

  resume(sessionID: string, now: number): Goal | undefined {
    const goal = this.focused(sessionID)
    if (!goal || goal.status === "achieved") return undefined
    goal.status = "active"
    goal.stopped = false
    goal.stopReason = ""
    goal.blockedReason = ""
    goal.pausedAt = null
    goal.startedAt = now // fresh budget window
    goal.turnCount = 0
    goal.lastContinuedMessageID = ""
    goal.wrapupSent = false
    goal.consecutiveFailures = 0
    goal.noProgressStreak = 0
    goal.noToolCallStreak = 0
    goal.updatedAt = now
    this.pushHistory(goal, "resumed", "", now)
    return goal
  }

  block(sessionID: string, reason: string, now: number): Goal | undefined {
    const goal = this.focused(sessionID)
    if (!goal) return undefined
    goal.status = "blocked"
    goal.stopped = true
    goal.stopReason = "blocked"
    goal.blockedReason = reason
    goal.pausedAt = now
    goal.updatedAt = now
    this.pushHistory(goal, "blocked", reason, now)
    return goal
  }

  complete(sessionID: string, evidence: string, now: number): Goal | undefined {
    const goal = this.focused(sessionID)
    if (!goal) return undefined
    goal.status = "achieved"
    goal.stopped = true
    goal.stopReason = "complete"
    goal.evidence = evidence
    goal.updatedAt = now
    this.pushHistory(goal, "completed", evidence, now)
    // Archive the goal.
    const state = this.session(sessionID)
    const archived: ArchivedGoal = {
      id: goal.id,
      condition: goal.condition,
      status: "achieved",
      evidence,
      stopReason: "complete",
      turnCount: goal.turnCount,
      startedAt: goal.startedAt,
      endedAt: now,
      totalTokens: goal.totalTokens,
    }
    state.archived.push(archived)
    state.goals = state.goals.filter((g) => g.id !== goal.id)
    state.focusedGoalID = state.goals.find((g) => g.focused)?.id ?? null
    this.evictArchived(state, now)
    return goal
  }

  /** Promote the next background goal into focus (ordered sequences). */
  promoteNext(sessionID: string, now: number): Goal | undefined {
    const state = this.session(sessionID)
    const next = state.goals.find((g) => !g.focused)
    if (!next) return undefined
    this.backgroundFocused(state)
    next.focused = true
    next.status = "active"
    next.stopped = false
    next.stopReason = ""
    next.pausedAt = null
    next.startedAt = now
    next.turnCount = 0
    next.wrapupSent = false
    state.focusedGoalID = next.id
    this.pushHistory(next, "promoted", next.condition, now)
    return next
  }

  clear(sessionID: string): void {
    const state = this.session(sessionID)
    state.goals = []
    state.focusedGoalID = null
    state.ordered = false
  }

  sequence(sessionID: string, items: string[], spec: CreateGoalSpec, now: number): Goal[] {
    const state = this.session(sessionID)
    this.backgroundFocused(state)
    state.goals = []
    state.ordered = true
    const created: Goal[] = []
    items.forEach((item, i) => {
      const goal = makeGoal(sessionID, { ...spec, condition: item, background: false }, now)
      goal.focused = i === 0
      state.goals.push(goal)
      this.pushHistory(goal, "created", item, now)
      created.push(goal)
      void i
    })
    state.focusedGoalID = created[0]?.id ?? null
    return created
  }

  applyUsage(goal: Goal, usage: Usage): void {
    goal.usage = usage
    goal.totalTokens = usage.input + usage.output + usage.reasoning
  }

  private evictArchived(state: SessionState, now: number): void {
    const cutoff = now - this.options.resultRetentionMs
    state.archived = state.archived.filter((a) => a.endedAt >= cutoff)
    if (state.archived.length > this.options.maxStoredResults) {
      state.archived.splice(0, state.archived.length - this.options.maxStoredResults)
    }
  }

  serialize(): StoreSnapshot {
    const sessions: Record<string, SessionState> = {}
    for (const [id, state] of this.sessions) sessions[id] = state
    return { version: 1, sessions }
  }

  load(snapshot: StoreSnapshot | undefined): void {
    if (!snapshot || snapshot.version !== 1 || !snapshot.sessions) return
    for (const [id, state] of Object.entries(snapshot.sessions)) {
      // Recovered active goals start paused so unattended runs do not resume blindly.
      for (const goal of state.goals) {
        if (goal.status === "active") {
          goal.status = "paused"
          goal.stopped = true
          goal.stopReason = "recovered after restart"
          goal.pausedAt = Date.now()
        }
      }
      this.sessions.set(id, state)
    }
  }
}
