/**
 * V2 HostPort adapter: maps the OpenCode V2 plugin context onto the engine's
 * HostPort. Message shapes are normalized defensively because the V2 message
 * schema is not exposed by the type package we depend on.
 */

import { isPluginOwnedText } from "../core/constants.ts"
import type { Usage } from "../core/types.ts"
import type {
  HostMessage,
  HostPort,
  LogLevel,
  SendPromptInput,
  SessionInfoLite,
} from "../ports.ts"
import type { V2Context } from "./context.ts"

function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const chunks: string[] = []
  for (const part of parts) {
    if (typeof part === "string") {
      chunks.push(part)
      continue
    }
    if (part && typeof part === "object") {
      const p = part as { type?: string; text?: unknown }
      if (p.type === "text" && typeof p.text === "string") chunks.push(p.text)
    }
  }
  return chunks.join("\n")
}

function partsHaveTool(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false
  return parts.some((p) => p && typeof p === "object" && (p as { type?: string }).type === "tool")
}

function usageFrom(info: Record<string, unknown>): Partial<Usage> {
  const tokens = info["tokens"] as
    | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
    | undefined
  const usage: Partial<Usage> = {}
  if (tokens) {
    usage.input = tokens.input ?? 0
    usage.output = tokens.output ?? 0
    usage.reasoning = tokens.reasoning ?? 0
    usage.cacheRead = tokens.cache?.read ?? 0
    usage.cacheWrite = tokens.cache?.write ?? 0
  }
  if (typeof info["cost"] === "number") usage.cost = info["cost"] as number
  return usage
}

function normalizeEntry(entry: unknown, index: number): HostMessage | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const e = entry as Record<string, unknown>
  const info = (e["info"] && typeof e["info"] === "object" ? e["info"] : e) as Record<string, unknown>
  const parts = e["parts"] ?? e["content"]
  const role = info["role"] ?? info["type"]
  if (role !== "user" && role !== "assistant") return undefined

  const id = typeof info["id"] === "string" ? info["id"] : `v2-${index}`
  let text = textOfParts(parts)
  if (!text && typeof info["text"] === "string") text = info["text"]
  if (!text && typeof e["text"] === "string") text = e["text"]

  const message: HostMessage = {
    id,
    role,
    text,
    hasToolCalls: role === "assistant" ? partsHaveTool(parts) : false,
    pluginOwned: role === "user" ? isPluginOwnedText(text) : false,
  }
  if (role === "assistant") message.usage = usageFrom(info)
  if (typeof info["agent"] === "string") message.agent = info["agent"]
  return message
}

export function createV2Port(ctx: V2Context): HostPort {
  const port: HostPort = {
    kind: "v2",

    async readRecentMessages(sessionID: string, limit: number): Promise<HostMessage[]> {
      const data = await ctx.session.context({ sessionID })
      if (!Array.isArray(data)) return []
      const out: HostMessage[] = []
      data.forEach((entry, index) => {
        const m = normalizeEntry(entry, index)
        if (m) out.push(m)
      })
      return out.slice(-limit)
    },

    async sendPrompt(input: SendPromptInput): Promise<void> {
      // V2 `session.prompt` takes { sessionID, text, files?, agents?, skills?,
      // delivery? } and has no agent/model fields; the session keeps its
      // selected agent/model across turns, so we must not send them (a strict
      // schema would reject excess properties).
      await ctx.session.prompt({ sessionID: input.sessionID, text: input.text })
    },

    storage: {
      get: (key: string) => ctx.storage.get(key),
      set: (key: string, value: unknown) => ctx.storage.set(key, value),
      remove: (key: string) => ctx.storage.remove(key),
    },

    async log(level: LogLevel, message: string, extra?: Record<string, unknown>): Promise<void> {
      if (level === "debug") return
      const line = `[opencode-goal-loop] ${message}`
      if (level === "error") console.error(line, extra ?? "")
      else if (level === "warn") console.warn(line, extra ?? "")
      else console.log(line, extra ?? "")
    },

    async toast(message: string): Promise<void> {
      // The V2 server plugin context has no toast API; log instead.
      console.log(`[opencode-goal-loop] ${message}`)
    },

    async getSession(sessionID: string): Promise<SessionInfoLite | undefined> {
      return { id: sessionID }
    },

    async setTitle(sessionID: string, title: string): Promise<void> {
      try {
        await ctx.session.update({ sessionID, title })
      } catch {
        // cosmetic only
      }
    },

    now(): number {
      return Date.now()
    },
  }
  return port
}
