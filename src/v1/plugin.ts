/**
 * V1 plugin entrypoint. Returns the OpenCode V1 hook map that drives the goal
 * engine through a V1 HostPort.
 */

import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { join } from "node:path"
import { Engine } from "../core/engine.ts"
import { normalizeOptions } from "../core/options.ts"
import { claimActivation } from "../lifecycle.ts"
import { createV1Port } from "./port.ts"
import { FilePersistence } from "./persist.ts"
import { buildV1Tools } from "./tools.ts"

function resolveStatePath(directory: string | undefined, stateFilePath: string | undefined): string {
  if (stateFilePath) return stateFilePath
  const env = process.env["OPENCODE_GOAL_STATE_PATH"]
  if (env) return env
  return join(directory ?? process.cwd(), ".opencode", "goals", "state.json")
}

export async function createV1Plugin(input: PluginInput, rawOptions?: PluginOptions): Promise<Hooks> {
  // Only activate if no other entrypoint owns this process.
  if (!claimActivation()) return {}

  const options = normalizeOptions(rawOptions)
  const port = createV1Port(input.client)
  const engine = new Engine(options, port)

  const persistence = options.persistState
    ? new FilePersistence(resolveStatePath(input.directory, options.stateFilePath))
    : null
  if (persistence) {
    const snapshot = await persistence.load()
    if (snapshot) engine.store.load(snapshot)
  }

  await port.log("info", "opencode-goal-loop ready (V1)", { directory: input.directory })

  const save = async (): Promise<void> => {
    if (!persistence) return
    try {
      await persistence.save(engine.store.serialize())
    } catch (err) {
      await port.log("error", "failed to persist goal state", { error: String(err) })
    }
  }

  const hooks: Hooks = {
    config: async (config) => {
      if (!options.registerCommand) return
      const cfg = config as { command?: Record<string, unknown> }
      if (!cfg.command) cfg.command = {}
      if (!cfg.command[options.commandName]) {
        cfg.command[options.commandName] = {
          description: "Set a session-scoped goal and auto-continue until complete.",
          template: "$ARGUMENTS",
        }
      }
    },

    event: async ({ event }) => {
      const e = event as { type?: string; properties?: { sessionID?: string } }
      const sessionID = e.properties?.sessionID
      if (!sessionID) return
      if (e.type === "session.idle") {
        await engine.onIdle(sessionID)
        await save()
      }
    },

    "chat.message": async (ci) => {
      engine.noteAgent(ci.sessionID, ci.agent, ci.model, ci.variant)
      engine.applyAgentHold(ci.sessionID, ci.agent)
    },

    "command.execute.before": async (ci, output) => {
      const name = ci.command.replace(/^\/+/, "")
      if (name !== options.commandName) return
      const outcome = await engine.runCommand(ci.sessionID, ci.arguments)
      const parts = output.parts
      let replaced = false
      for (const part of parts) {
        if (part.type === "text") {
          ;(part as { text: string }).text = outcome.prompt
          replaced = true
          break
        }
      }
      if (!replaced) {
        parts.push({
          id: "",
          sessionID: ci.sessionID,
          messageID: "",
          type: "text",
          text: outcome.prompt,
        } as (typeof parts)[number])
      }
      if (outcome.notice) await port.log("info", `[goal-loop] ${outcome.notice}`)
      await save()
    },

    "experimental.session.compacting": async (ci, co) => {
      const ctx = engine.compactionContext(ci.sessionID)
      if (ctx) co.context.push(ctx)
    },

    "experimental.compaction.autocontinue": async (ci, co) => {
      if (!engine.shouldAutoContinueAfterCompaction(ci.sessionID)) co.enabled = false
    },

    dispose: async () => {
      await save()
    },
  }

  if (options.registerTools) hooks.tool = buildV1Tools(engine)
  return hooks
}
