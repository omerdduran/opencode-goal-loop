/**
 * Agent-facing goal tools for V1. Definitions are built with zod schemas and
 * return compact JSON envelopes so agents can branch reliably.
 */

import type { ToolDefinition } from "@opencode-ai/plugin"
import { z } from "zod"
import type { Engine } from "../core/engine.ts"
import type { Goal } from "../core/types.ts"

function envelope(ok: boolean, data: Record<string, unknown>): string {
  return JSON.stringify({ plugin: "opencode-goal-loop", version: 1, ok, ...data })
}

function snapshot(goal: Goal): Record<string, unknown> {
  return {
    id: goal.id,
    condition: goal.condition,
    status: goal.status,
    focused: goal.focused,
    turnCount: goal.turnCount,
    totalTokens: goal.totalTokens,
    stopped: goal.stopped,
    stopReason: goal.stopReason,
    blockedReason: goal.blockedReason,
    evidence: goal.evidence,
  }
}

export function buildV1Tools(engine: Engine): Record<string, ToolDefinition> {
  const defs: Record<string, ToolDefinition> = {}

  defs["goal_status"] = {
    description: "Report the active goal's status, budget, and recent history.",
    args: {},
    execute: async (_args, context) => envelope(true, { status: engine.statusText(context.sessionID) }),
  }

  defs["goal_set"] = {
    description:
      "Set a session-scoped goal. Only use for a goal the user explicitly requested. Returns the goal snapshot.",
    args: {
      condition: z.string().describe("The objective to pursue until complete"),
      successCriteria: z.string().optional(),
      constraints: z.string().optional(),
    },
    execute: async (rawArgs, context) => {
      const args = rawArgs as { condition: string; successCriteria?: string; constraints?: string }
      const goal = engine.setGoalFromTool(context.sessionID, args.condition, context.agent)
      if (!goal) return envelope(false, { error: "empty_condition" })
      return envelope(true, { goal: snapshot(goal) })
    },
  }

  defs["goal_pause"] = {
    description: "Pause auto-continuation for the active goal without clearing it.",
    args: {},
    execute: async (_args, context) => {
      const goal = engine.pauseGoal(context.sessionID, "tool requested pause")
      return goal ? envelope(true, { goal: snapshot(goal) }) : envelope(false, { error: "no_goal" })
    },
  }

  defs["goal_resume"] = {
    description: "Resume a paused goal with a fresh budget window.",
    args: {},
    execute: async (_args, context) => {
      const goal = engine.resumeGoal(context.sessionID)
      return goal ? envelope(true, { goal: snapshot(goal) }) : envelope(false, { error: "no_goal" })
    },
  }

  defs["goal_block"] = {
    description: "Mark the active goal blocked, with the concrete blocker as the reason.",
    args: { reason: z.string().describe("The concrete blocker requiring user input") },
    execute: async (rawArgs, context) => {
      const args = rawArgs as { reason: string }
      const goal = engine.blockGoal(context.sessionID, args.reason)
      return goal ? envelope(true, { goal: snapshot(goal) }) : envelope(false, { error: "no_goal" })
    },
  }

  defs["goal_complete"] = {
    description:
      "Mark the active goal complete. Provide a non-empty summary of what was verified as evidence.",
    args: {
      summary: z.string().describe("What was verified: commands run, files checked, results"),
    },
    execute: async (rawArgs, context) => {
      const args = rawArgs as { summary: string }
      if (!args.summary.trim()) return envelope(false, { error: "empty_evidence" })
      const goal = engine.completeGoal(context.sessionID, args.summary)
      return goal ? envelope(true, { goal: snapshot(goal) }) : envelope(false, { error: "no_goal" })
    },
  }

  return defs
}
