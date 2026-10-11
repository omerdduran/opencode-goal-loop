/**
 * Core domain types. These are platform-independent: they describe a goal and
 * its lifecycle without referencing any OpenCode V1 or V2 API surface.
 */

export type GoalStatus = "active" | "paused" | "blocked" | "achieved"

export type GoalMode = "normal" | "ordered"

/** A bounded progress checkpoint captured from an assistant turn. */
export interface GoalCheckpoint {
  summary: string
  timestamp: number
}

/** A timestamped lifecycle entry retained with a goal. */
export interface GoalHistoryEntry {
  type: string
  detail: string
  timestamp: number
}

/** Accumulated token/cost usage for a goal run. */
export interface Usage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  costKnown: boolean
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  }
}

/** Per-goal limit overrides parsed from `/goal` flags. */
export interface LimitOverrides {
  maxTurns: number
  maxDurationMs: number
  maxTokens: number
  maxCostUsd: number
  minDelayMs: number
  noProgressTokenThreshold: number
  noProgressTurnsBeforePause: number
  noToolCallTurnsBeforePause: number
  budgetWrapupRatio: number
  maxPromptFailures: number
}

/** A single goal and its full lifecycle record. */
export interface Goal {
  id: string
  sessionID: string
  condition: string
  successCriteria: string
  constraints: string
  mode: GoalMode
  status: GoalStatus
  focused: boolean

  turnCount: number
  startedAt: number
  pausedAt: number | null
  updatedAt: number
  totalTokens: number
  usage: Usage

  /** Agent/model/variant that initiated the goal; reused for continuations. */
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string

  lastCheckpoint: GoalCheckpoint | null
  checkpoints: GoalCheckpoint[]
  history: GoalHistoryEntry[]

  stopped: boolean
  stopReason: string
  blockedReason: string
  evidence: string

  /** Per-goal limit overrides. */
  limits: Partial<LimitOverrides>

  /** Bookkeeping for the continuation loop. */
  lastContinuedMessageID: string
  lastAnalyzedMessageID: string
  lastContinueAt: number
  noProgressStreak: number
  noToolCallStreak: number
  consecutiveFailures: number
  wrapupSent: boolean
}

/** An archived (terminal) goal summary retained for `/goal status`. */
export interface ArchivedGoal {
  id: string
  condition: string
  status: GoalStatus
  evidence: string
  stopReason: string
  turnCount: number
  startedAt: number
  endedAt: number
  totalTokens: number
}

/** All goal state for one session. */
export interface SessionState {
  sessionID: string
  focusedGoalID: string | null
  goals: Goal[]
  archived: ArchivedGoal[]
  ordered: boolean
  originalTitle?: string
}

export function emptySessionState(sessionID: string): SessionState {
  return {
    sessionID,
    focusedGoalID: null,
    goals: [],
    archived: [],
    ordered: false,
  }
}

/** Snapshot passed to a custom completion auditor. */
export interface AuditSnapshot {
  goal: Readonly<Goal>
  sessionID: string
  latestText: string
}

export interface AuditVerdict {
  approved: boolean
  reason?: string
}

export type Auditor = (snapshot: AuditSnapshot) => Promise<AuditVerdict> | AuditVerdict
