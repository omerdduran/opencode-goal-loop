/**
 * Agent-facing goal tools for V2, registered through `ctx.tool.transform`.
 * Uses JSON Schema inputs (V2 tool convention) and returns JSON envelopes.
 */

import type { Engine } from "../core/engine.ts"
import type { Goal } from "../core/types.ts"
import type { V2ToolContext } from "./context.ts"

export interface V2ToolEditor {
  add(tool: unknown): void
  namespace?(ns: unknown): void
}

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

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false }

export function registerV2Tools(editor: V2ToolEditor, engine: Engine): void {
  editor.add({
    name: "goal_status",
    description: "Report the active goal's status, budget, and recent history.",
    input: EMPTY_SCHEMA,
    execute: async (_input: unknown, context: V2ToolContext) => ({
      content: envelope(true, { status: engine.statusText(context.sessionID) }),
    }),
  })

  editor.add({
    name: "goal_set",
    description:
      "Set a session-scoped goal. Only use for a goal the user explicitly requested.",
    input: {
      type: "object",
      properties: {
        condition: { type: "string", description: "The objective to pursue until complete" },
        successCriteria: { type: "string" },
        constraints: { type: "string" },
      },
      required: ["condition"],
      additionalProperties: false,
    },
    execute: async (input: unknown, context: V2ToolContext) => {
      const args = input as { condition: string }
      const goal = engine.setGoalFromTool(context.sessionID, args.condition)
      if (!goal) return { content: envelope(false, { error: "empty_condition" }) }
      return { content: envelope(true, { goal: snapshot(goal) }) }
    },
  })

  editor.add({
    name: "goal_pause",
    description: "Pause auto-continuation for the active goal without clearing it.",
    input: EMPTY_SCHEMA,
    execute: async (_input: unknown, context: V2ToolContext) => {
      const goal = engine.pauseGoal(context.sessionID, "tool requested pause")
      return goal
        ? { content: envelope(true, { goal: snapshot(goal) }) }
        : { content: envelope(false, { error: "no_goal" }) }
    },
  })

  editor.add({
    name: "goal_resume",
    description: "Resume a paused goal with a fresh budget window.",
    input: EMPTY_SCHEMA,
    execute: async (_input: unknown, context: V2ToolContext) => {
      const goal = engine.resumeGoal(context.sessionID)
      return goal
        ? { content: envelope(true, { goal: snapshot(goal) }) }
        : { content: envelope(false, { error: "no_goal" }) }
    },
  })

  editor.add({
    name: "goal_block",
    description: "Mark the active goal blocked, with the concrete blocker as the reason.",
    input: {
      type: "object",
      properties: { reason: { type: "string", description: "The concrete blocker" } },
      required: ["reason"],
      additionalProperties: false,
    },
    execute: async (input: unknown, context: V2ToolContext) => {
      const args = input as { reason: string }
      const goal = engine.blockGoal(context.sessionID, args.reason)
      return goal
        ? { content: envelope(true, { goal: snapshot(goal) }) }
        : { content: envelope(false, { error: "no_goal" }) }
    },
  })

  editor.add({
    name: "goal_complete",
    description:
      "Mark the active goal complete. Provide a non-empty summary of what was verified as evidence.",
    input: {
      type: "object",
      properties: { summary: { type: "string", description: "What was verified" } },
      required: ["summary"],
      additionalProperties: false,
    },
    execute: async (input: unknown, context: V2ToolContext) => {
      const args = input as { summary: string }
      if (!args.summary.trim()) return { content: envelope(false, { error: "empty_evidence" }) }
      const goal = engine.completeGoal(context.sessionID, args.summary)
      return goal
        ? { content: envelope(true, { goal: snapshot(goal) }) }
        : { content: envelope(false, { error: "no_goal" }) }
    },
  })
}
