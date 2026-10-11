/**
 * V2 plugin entrypoint. Registers commands, hooks, tools, and an event
 * subscription on an OpenCode V2 plugin context, returning a cleanup function.
 */

import { Engine } from "../core/engine.ts"
import { normalizeOptions } from "../core/options.ts"
import { claimActivation } from "../lifecycle.ts"
import type { V2Context, V2RequestEvent } from "./context.ts"
import { V2Persistence } from "./persist.ts"
import { createV2Port } from "./port.ts"
import { registerV2Tools, type V2ToolEditor } from "./tools.ts"

interface Registration {
  dispose(): Promise<void>
}

function isRegistration(value: unknown): value is Registration {
  return !!value && typeof (value as Registration).dispose === "function"
}

export async function setupV2(rawCtx: unknown): Promise<() => Promise<void>> {
  const ctx = rawCtx as V2Context
  // Some OpenCode 1.18.x builds call setup with an empty context alongside the
  // V1 `server` entrypoint. Only a real V2 host (with `ctx.app.version`) should
  // activate, and only if no other entrypoint already claimed the process.
  if (!ctx.app || typeof ctx.app.version !== "string" || ctx.app.version.length === 0) {
    return async () => {}
  }
  if (!claimActivation()) return async () => {}
  const options = normalizeOptions(ctx.options ?? {})
  const port = createV2Port(ctx)
  const engine = new Engine(options, port)

  const persistence = options.persistState ? new V2Persistence(ctx.storage) : null
  if (persistence) {
    const snapshot = await persistence.load()
    if (snapshot) engine.store.load(snapshot)
  }

  await port.log("info", "opencode-goal-loop ready (V2)", { version: ctx.app?.version })

  const save = async (): Promise<void> => {
    if (!persistence) return
    try {
      await persistence.save(engine.store.serialize())
    } catch (err) {
      await port.log("error", "failed to persist goal state", { error: String(err) })
    }
  }

  const disposers: Registration[] = []
  const track = (registration: unknown): void => {
    if (isRegistration(registration)) disposers.push(registration)
  }

  // Inject the active goal into every agent-loop model request.
  track(
    await ctx.session.hook("context", (event: V2RequestEvent) => {
      const sessionID = event.sessionID
      if (!sessionID) return
      engine.noteAgent(
        sessionID,
        event.agent,
        event.model
          ? { providerID: event.model.providerID, modelID: event.model.id ?? event.model.modelID ?? "" }
          : undefined,
      )
      engine.applyAgentHold(sessionID, event.agent)
      const block = engine.activeGoalBlock(sessionID)
      if (block) event.system.push({ type: "text", text: block })
    }),
  )

  // Keep the goal visible through compaction (best effort; continuations also
  // re-inject the objective, so correctness does not depend on this).
  track(
    await ctx.session.hook("compaction", (event: V2RequestEvent) => {
      try {
        const block = event.sessionID ? engine.compactionContext(event.sessionID) : undefined
        if (!block) return
        const messages = event.messages
        if (!Array.isArray(messages)) return
        const first = messages[0]
        const looksLikeMessages =
          messages.length === 0 ||
          (first !== null && typeof first === "object" && "role" in (first as object))
        if (!looksLikeMessages) return
        messages.push({ role: "user", content: block })
      } catch {
        // Never break compaction.
      }
    }),
  )

  if (options.registerCommand) {
    track(
      await ctx.command.transform((editor) => {
        editor.add({
          name: options.commandName,
          description: "Set a session-scoped goal and auto-continue until complete.",
          execute: async (invocation: unknown) => {
            const inv = invocation as {
              sessionID: string
              prompt?: Record<string, unknown>
              delivery?: unknown
            }
            const sourceText =
              inv.prompt && typeof inv.prompt["text"] === "string" ? (inv.prompt["text"] as string) : ""
            const outcome = await engine.runCommand(inv.sessionID, sourceText)
            // Preserve attachments (files/agents/skills) from the command prompt.
            const body: Record<string, unknown> = {
              ...(inv.prompt ?? {}),
              sessionID: inv.sessionID,
              text: outcome.prompt,
            }
            if (inv.delivery !== undefined) body["delivery"] = inv.delivery
            await ctx.session.prompt(body)
            if (outcome.notice) await port.log("info", `[goal-loop] ${outcome.notice}`)
            await save()
          },
        })
      }),
    )
  }

  if (options.registerTools) {
    track(
      await ctx.tool.transform((editor) => {
        registerV2Tools(editor as V2ToolEditor, engine)
      }),
    )
  }

  const controller = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      const sessionID = event.data?.sessionID ?? event.properties?.sessionID
      if (!sessionID) continue
      if (event.type === "session.idle") {
        await engine.onIdle(sessionID)
        await save()
      }
    }
  })().catch(() => {
    // stream ended or aborted
  })

  return async () => {
    controller.abort()
    for (const registration of disposers) {
      try {
        await registration.dispose()
      } catch {
        // ignore
      }
    }
    await save()
  }
}
