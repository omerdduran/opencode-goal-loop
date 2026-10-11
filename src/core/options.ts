/**
 * Plugin options: defaults, normalization, and limit resolution.
 */

import { DEFAULT_COMMAND_NAME, DEFAULT_RESTRICTED_AGENTS } from "./constants.ts"
import type { Auditor, Goal, LimitOverrides } from "./types.ts"

export interface PluginOptions {
  // Command / registration
  commandName: string
  registerCommand: boolean
  registerTools: boolean

  // Limits (defaults; overridable per goal)
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

  // Loop behavior
  maxRecentMessages: number
  noInterruptOnUserMessage: boolean
  noContinueWhileChildrenActive: boolean

  // Persistence
  persistState: boolean
  stateFilePath?: string
  resultRetentionMs: number
  maxStoredResults: number

  // Agents / safety
  restrictedAgents: string[]
  allowGoalExecutionFromPlan: boolean

  // UX / messaging
  lifecycleMessages: boolean
  sessionTitleStatus: boolean

  // Completion auditing
  auditor?: Auditor
}

export const DEFAULT_OPTIONS: PluginOptions = {
  commandName: DEFAULT_COMMAND_NAME,
  registerCommand: true,
  registerTools: true,

  maxTurns: 10,
  maxDurationMs: 900_000,
  maxTokens: 200_000,
  maxCostUsd: 0,
  minDelayMs: 1_500,
  noProgressTokenThreshold: 50,
  noProgressTurnsBeforePause: 2,
  noToolCallTurnsBeforePause: 2,
  budgetWrapupRatio: 0.8,
  maxPromptFailures: 3,

  maxRecentMessages: 50,
  noInterruptOnUserMessage: false,
  noContinueWhileChildrenActive: false,

  persistState: true,
  resultRetentionMs: 604_800_000,
  maxStoredResults: 200,

  restrictedAgents: [...DEFAULT_RESTRICTED_AGENTS],
  allowGoalExecutionFromPlan: false,

  lifecycleMessages: true,
  sessionTitleStatus: false,
}

function num(raw: unknown, fallback: number, { min = 0, integer = false } = {}): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < min) return fallback
  return integer ? Math.floor(n) : n
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback
}

function str(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : fallback
}

/**
 * Normalize a raw options object (from `opencode.json`) into a fully-populated
 * option set. Invalid values fall back to defaults instead of throwing so a
 * plugin misconfiguration cannot break the host.
 */
export function normalizeOptions(raw: unknown): PluginOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const commandName = str(o["commandName"], DEFAULT_OPTIONS.commandName).replace(/^\/+/, "")

  let restrictedAgents = DEFAULT_OPTIONS.restrictedAgents
  if (Array.isArray(o["restrictedAgents"])) {
    restrictedAgents = o["restrictedAgents"].filter((x): x is string => typeof x === "string")
  }

  return {
    commandName,
    registerCommand: bool(o["registerCommand"], DEFAULT_OPTIONS.registerCommand),
    registerTools: bool(o["registerTools"], DEFAULT_OPTIONS.registerTools),

    maxTurns: num(o["maxTurns"], DEFAULT_OPTIONS.maxTurns, { min: 1, integer: true }),
    maxDurationMs: num(o["maxDurationMs"], DEFAULT_OPTIONS.maxDurationMs, { min: 1 }),
    maxTokens: num(o["maxTokens"], DEFAULT_OPTIONS.maxTokens, { min: 1 }),
    maxCostUsd: num(o["maxCostUsd"], DEFAULT_OPTIONS.maxCostUsd, { min: 0 }),
    minDelayMs: num(o["minDelayMs"], DEFAULT_OPTIONS.minDelayMs, { min: 0 }),
    noProgressTokenThreshold: num(
      o["noProgressTokenThreshold"],
      DEFAULT_OPTIONS.noProgressTokenThreshold,
      { min: 0 },
    ),
    noProgressTurnsBeforePause: num(
      o["noProgressTurnsBeforePause"],
      DEFAULT_OPTIONS.noProgressTurnsBeforePause,
      { min: 0, integer: true },
    ),
    noToolCallTurnsBeforePause: num(
      o["noToolCallTurnsBeforePause"],
      DEFAULT_OPTIONS.noToolCallTurnsBeforePause,
      { min: 0, integer: true },
    ),
    budgetWrapupRatio: Math.min(
      0.99,
      Math.max(0.1, num(o["budgetWrapupRatio"], DEFAULT_OPTIONS.budgetWrapupRatio, { min: 0.1 })),
    ),
    maxPromptFailures: num(o["maxPromptFailures"], DEFAULT_OPTIONS.maxPromptFailures, {
      min: 1,
      integer: true,
    }),

    maxRecentMessages: num(o["maxRecentMessages"], DEFAULT_OPTIONS.maxRecentMessages, {
      min: 1,
      integer: true,
    }),
    noInterruptOnUserMessage: bool(o["noInterruptOnUserMessage"], false),
    noContinueWhileChildrenActive: bool(o["noContinueWhileChildrenActive"], false),

    persistState: bool(o["persistState"], DEFAULT_OPTIONS.persistState),
    stateFilePath: typeof o["stateFilePath"] === "string" ? o["stateFilePath"] : undefined,
    resultRetentionMs: num(o["resultRetentionMs"], DEFAULT_OPTIONS.resultRetentionMs, { min: 0 }),
    maxStoredResults: num(o["maxStoredResults"], DEFAULT_OPTIONS.maxStoredResults, {
      min: 1,
      integer: true,
    }),

    restrictedAgents,
    allowGoalExecutionFromPlan: bool(o["allowGoalExecutionFromPlan"], false),

    lifecycleMessages: bool(o["lifecycleMessages"], DEFAULT_OPTIONS.lifecycleMessages),
    sessionTitleStatus: bool(o["sessionTitleStatus"], DEFAULT_OPTIONS.sessionTitleStatus),

    auditor: typeof o["auditor"] === "function" ? (o["auditor"] as Auditor) : undefined,
  }
}

/** The plugin-level defaults expressed as per-goal limit overrides. */
export function defaultLimits(options: PluginOptions): LimitOverrides {
  return {
    maxTurns: options.maxTurns,
    maxDurationMs: options.maxDurationMs,
    maxTokens: options.maxTokens,
    maxCostUsd: options.maxCostUsd,
    minDelayMs: options.minDelayMs,
    noProgressTokenThreshold: options.noProgressTokenThreshold,
    noProgressTurnsBeforePause: options.noProgressTurnsBeforePause,
    noToolCallTurnsBeforePause: options.noToolCallTurnsBeforePause,
    budgetWrapupRatio: options.budgetWrapupRatio,
    maxPromptFailures: options.maxPromptFailures,
  }
}

/** Resolve the effective limits for a goal (defaults merged with overrides). */
export function resolveLimits(options: PluginOptions, goal: Goal): LimitOverrides {
  return { ...defaultLimits(options), ...goal.limits }
}
