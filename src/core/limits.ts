/**
 * Safety limits, wrap-up decisions, and human-readable budget summaries.
 */

import type { PluginOptions } from "./options.ts"
import { resolveLimits } from "./options.ts"
import type { Goal } from "./types.ts"

export interface LimitStatus {
  exhausted: boolean
  /** A short machine reason, e.g. "max turns". */
  reason: string
  /** Human-readable limit-approaching warnings. */
  warnings: string[]
  /** True when the goal is nearing any budget and has not yet wrapped up. */
  shouldWrapup: boolean
}

export function elapsedMs(goal: Goal, now: number): number {
  return Math.max(0, now - goal.startedAt)
}

export function evaluateLimits(goal: Goal, options: PluginOptions, now: number): LimitStatus {
  const limits = resolveLimits(options, goal)
  const warnings: string[] = []
  let exhausted = false
  let reason = ""

  const turnsLeft = limits.maxTurns - goal.turnCount
  const msLeft = limits.maxDurationMs - elapsedMs(goal, now)
  const tokensLeft = limits.maxTokens - goal.totalTokens

  if (goal.turnCount >= limits.maxTurns) {
    exhausted = true
    reason = `reached max turns (${limits.maxTurns})`
  } else if (msLeft <= 0) {
    exhausted = true
    reason = `reached max duration (${Math.round(limits.maxDurationMs / 60000)}m)`
  } else if (goal.totalTokens >= limits.maxTokens) {
    exhausted = true
    reason = `reached token budget (${limits.maxTokens})`
  } else if (
    limits.maxCostUsd > 0 &&
    goal.usage.costKnown &&
    goal.usage.cost >= limits.maxCostUsd
  ) {
    exhausted = true
    reason = `reached cost budget ($${limits.maxCostUsd})`
  }

  if (turnsLeft > 0 && turnsLeft <= 3) warnings.push(`${turnsLeft} turn(s) left`)
  if (msLeft > 0 && msLeft <= 60_000) warnings.push(`${Math.ceil(msLeft / 1000)}s left`)
  if (tokensLeft > 0 && tokensLeft <= 25_000) warnings.push(`${tokensLeft} tokens left`)

  const ratio = limits.budgetWrapupRatio
  const nearTurns = goal.turnCount >= limits.maxTurns * ratio
  const nearTime = elapsedMs(goal, now) >= limits.maxDurationMs * ratio
  const nearTokens = goal.totalTokens >= limits.maxTokens * ratio
  const shouldWrapup = !goal.wrapupSent && (nearTurns || nearTime || nearTokens)

  return { exhausted, reason, warnings, shouldWrapup }
}

/** A compact one-line budget summary for status output. */
export function budgetLine(goal: Goal, options: PluginOptions, now: number): string {
  const limits = resolveLimits(options, goal)
  const mins = Math.floor(elapsedMs(goal, now) / 60_000)
  const parts = [
    `${goal.turnCount}/${limits.maxTurns} turns`,
    `${mins}m`,
    `${goal.totalTokens}/${limits.maxTokens} tokens`,
  ]
  if (limits.maxCostUsd > 0) parts.push(`$${goal.usage.cost.toFixed(2)}/$${limits.maxCostUsd}`)
  return parts.join(" · ")
}
