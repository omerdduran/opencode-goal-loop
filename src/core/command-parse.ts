/**
 * Parse the `/goal` command arguments into a structured action.
 *
 * Grammar (informal):
 *   /goal [subcommand] [objective...] [--flag value | --flag=value ...]
 *
 * Subcommands: set(default) add list focus status history pause resume edit
 *              clear (aliases stop/off/reset/none/cancel) sequence
 */

import type { GoalMode, LimitOverrides } from "./types.ts"

export type CommandAction =
  | "set"
  | "add"
  | "list"
  | "focus"
  | "status"
  | "history"
  | "pause"
  | "resume"
  | "edit"
  | "clear"
  | "sequence"

export interface ParsedCommand {
  action: CommandAction
  objective: string
  sequence: string[]
  focusIndex?: number
  successCriteria: string
  constraints: string
  mode?: GoalMode
  limits: Partial<LimitOverrides>
  error?: string
}

const SUBCOMMANDS: Record<string, CommandAction> = {
  set: "set",
  add: "add",
  list: "list",
  focus: "focus",
  status: "status",
  history: "history",
  pause: "pause",
  resume: "resume",
  edit: "edit",
  clear: "clear",
  stop: "clear",
  off: "clear",
  reset: "clear",
  none: "clear",
  cancel: "clear",
  sequence: "sequence",
}

/** Flags that map directly to a numeric limit override. */
const NUMERIC_FLAGS: Record<string, keyof LimitOverrides> = {
  "--max-turns": "maxTurns",
  "--max-duration-ms": "maxDurationMs",
  "--max-tokens": "maxTokens",
  "--max-cost": "maxCostUsd",
  "--cooldown-ms": "minDelayMs",
  "--no-progress-threshold": "noProgressTokenThreshold",
  "--no-progress-turns": "noProgressTurnsBeforePause",
  "--no-tool-turns": "noToolCallTurnsBeforePause",
}

function parseBudgetToTokens(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw.trim())
  if (!m) return undefined
  const value = Number(m[1])
  const suffix = (m[2] ?? "").toLowerCase()
  if (suffix === "k") return Math.floor(value * 1_000)
  if (suffix === "m") return Math.floor(value * 1_000_000)
  return Math.floor(value)
}

/**
 * Replace ``` fenced spans with opaque placeholders so their contents are not
 * tokenized. Returns the rewritten text plus the original spans.
 */
function protectFences(input: string): { text: string; fences: string[] } {
  const fences: string[] = []
  const text = input.replace(/```[\s\S]*?```/g, (match) => {
    const idx = fences.length
    fences.push(match)
    return `\u0000FENCE${idx}\u0000`
  })
  return { text, fences }
}

function restoreFences(value: string, fences: string[]): string {
  return value.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)] ?? "")
}

/** Whitespace tokenizer that respects single and double quotes. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

export function parseCommand(raw: string): ParsedCommand {
  const trimmed = raw.trim()
  const base: ParsedCommand = {
    action: "status",
    objective: "",
    sequence: [],
    successCriteria: "",
    constraints: "",
    limits: {},
  }
  if (trimmed.length === 0) return base

  const { text: protectedText, fences } = protectFences(trimmed)
  const tokens = tokenize(protectedText)
  if (tokens.length === 0) return base

  let action: CommandAction = "set"
  let cursor = 0
  const first = tokens[0]!.toLowerCase()
  if (first in SUBCOMMANDS) {
    action = SUBCOMMANDS[first]!
    cursor = 1
  }

  // `/goal focus N`
  let focusIndex: number | undefined
  if (action === "focus") {
    const next = tokens[cursor]
    if (next !== undefined && /^\d+$/.test(next)) {
      focusIndex = Number(next)
      cursor++
    }
  }

  const objectiveTokens: string[] = []
  const limits: Partial<LimitOverrides> = {}
  let successCriteria = ""
  let constraints = ""
  let mode: GoalMode | undefined
  const errors: string[] = []

  while (cursor < tokens.length) {
    const token = tokens[cursor]!
    if (token.startsWith("--")) {
      let flag = token
      let inlineValue: string | undefined
      const eq = token.indexOf("=")
      if (eq !== -1) {
        flag = token.slice(0, eq)
        inlineValue = token.slice(eq + 1)
      }
      const value = inlineValue !== undefined ? inlineValue : tokens[cursor + 1]
      if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
        errors.push(`Missing value for ${flag}`)
        cursor++
        continue
      }
      if (inlineValue === undefined) cursor++ // consume value token

      const take = () => restoreFences(value, fences)

      if (flag in NUMERIC_FLAGS) {
        const key = NUMERIC_FLAGS[flag]!
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) {
          errors.push(`Invalid value for ${flag}: ${value}`)
        } else {
          limits[key] = n
        }
      } else if (flag === "--budget") {
        const n = parseBudgetToTokens(value)
        if (n === undefined || n <= 0) errors.push(`Invalid value for --budget: ${value}`)
        else limits.maxTokens = n
      } else if (flag === "--max-minutes") {
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) errors.push(`Invalid value for --max-minutes: ${value}`)
        else limits.maxDurationMs = Math.floor(n * 60_000)
      } else if (flag === "--success" || flag === "--success-criteria") {
        successCriteria = take()
      } else if (flag === "--constraints" || flag === "--non-goals") {
        constraints = take()
      } else if (flag === "--mode") {
        const v = value.toLowerCase()
        if (v === "normal" || v === "ordered") mode = v
        else errors.push(`Invalid --mode: ${value} (expected normal|ordered)`)
      } else {
        errors.push(`Unknown flag: ${flag}`)
      }
      cursor++
      continue
    }

    objectiveTokens.push(token)
    cursor++
  }

  const objective = restoreFences(objectiveTokens.join(" "), fences).trim()
  const sequence =
    action === "sequence"
      ? objective
          .split(/[;\n]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : []

  const result: ParsedCommand = {
    action,
    objective,
    sequence,
    successCriteria,
    constraints,
    limits,
  }
  if (mode !== undefined) result.mode = mode
  if (focusIndex !== undefined) result.focusIndex = focusIndex
  if (errors.length > 0) result.error = errors.join("; ")
  return result
}
