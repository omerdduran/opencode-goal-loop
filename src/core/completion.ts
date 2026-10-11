/**
 * Parse completion / blocker markers from an assistant response and apply the
 * evidence gate. Markers must appear on their own final line.
 */

import { BARE_BLOCKED, BARE_COMPLETE, BARE_EVIDENCE } from "./constants.ts"

export type OutcomeKind = "none" | "complete" | "blocked" | "invalid-complete" | "invalid-blocked"

export interface Outcome {
  kind: OutcomeKind
  evidence: string
  blocker: string
}

const EMPTY: Outcome = { kind: "none", evidence: "", blocker: "" }

function normalizeLine(line: string): string {
  return line
    .replace(/^[>\s]+/, "")
    .replace(/[`*_]+/g, "")
    .replace(/[.!]+$/g, "")
    .trim()
    .toLowerCase()
}

function isCompleteLine(line: string): boolean {
  const l = normalizeLine(line)
  return l === "[goal:complete]" || l === BARE_COMPLETE
}

function isBlockedLine(line: string): boolean {
  const l = normalizeLine(line)
  return l === "[goal:blocked]" || l === BARE_BLOCKED
}

/** Returns the summary text after an evidence marker, or null if not evidence. */
function evidenceSummary(line: string): string | null {
  const trimmed = line.trim().replace(/^[>*\s-]+/, "")
  const lower = trimmed.toLowerCase()
  for (const marker of ["[goal:evidence]", BARE_EVIDENCE]) {
    if (lower.startsWith(marker)) {
      return trimmed.slice(marker.length).replace(/^[:\s-]+/, "").trim()
    }
  }
  return null
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

export function parseOutcome(text: string): Outcome {
  if (!text || text.trim().length === 0) return EMPTY
  const lines = nonEmptyLines(text)
  if (lines.length === 0) return EMPTY
  const last = lines[lines.length - 1]!
  const prev = lines.length >= 2 ? lines[lines.length - 2]! : undefined
  const beforePrev = lines.length >= 3 ? lines[lines.length - 3]! : undefined

  if (isCompleteLine(last)) {
    if (prev !== undefined) {
      const summary = evidenceSummary(prev)
      if (summary !== null && summary.length > 0) {
        return { kind: "complete", evidence: summary, blocker: "" }
      }
      // Historical two-line form: bare `[goal:evidence]`, then the summary.
      if (summary !== null && summary.length === 0 && beforePrev !== undefined) {
        const carried = beforePrev.trim()
        if (carried.length > 0 && evidenceSummary(carried) === null) {
          return { kind: "complete", evidence: carried, blocker: "" }
        }
      }
    }
    return { kind: "invalid-complete", evidence: "", blocker: "" }
  }

  if (isBlockedLine(last)) {
    if (
      prev !== undefined &&
      prev.trim().length > 0 &&
      !isCompleteLine(prev) &&
      !isBlockedLine(prev) &&
      evidenceSummary(prev) === null
    ) {
      return { kind: "blocked", evidence: "", blocker: prev.trim() }
    }
    return { kind: "invalid-blocked", evidence: "", blocker: "" }
  }

  return EMPTY
}
