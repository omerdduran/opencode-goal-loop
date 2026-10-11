/**
 * V1 HostPort adapter: maps an `@opencode-ai/sdk` client (as provided to a V1
 * plugin) onto the platform-independent HostPort the engine uses.
 *
 * The client is typed loosely on purpose so this package does not require the
 * SDK at runtime.
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

interface AnyClient {
  session: {
    messages(input: {
      path: { id: string }
      query?: { limit?: number; directory?: string }
    }): Promise<{ data?: unknown } | unknown>
    prompt(input: { path: { id: string }; body: unknown }): Promise<unknown>
    promptAsync?(input: { path: { id: string }; body: unknown }): Promise<unknown>
    get(input: { path: { id: string } }): Promise<{ data?: unknown } | unknown>
    children?(input: { path: { id: string } }): Promise<{ data?: unknown } | unknown>
    status?(input?: unknown): Promise<{ data?: unknown } | unknown>
  }
  app: { log(input: { body: unknown }): Promise<unknown> }
  tui?: { showToast?(input: { body: unknown }): Promise<unknown> }
}

function unwrap(result: unknown): unknown {
  if (result && typeof result === "object" && "data" in (result as Record<string, unknown>)) {
    return (result as { data?: unknown }).data
  }
  return result
}

function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const chunks: string[] = []
  for (const part of parts) {
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

function usageFromInfo(info: Record<string, unknown>): Partial<Usage> {
  const tokens = info["tokens"] as
    | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
    | undefined
  const cost = typeof info["cost"] === "number" ? (info["cost"] as number) : undefined
  const usage: Partial<Usage> = {}
  if (tokens) {
    usage.input = tokens.input ?? 0
    usage.output = tokens.output ?? 0
    usage.reasoning = tokens.reasoning ?? 0
    usage.cacheRead = tokens.cache?.read ?? 0
    usage.cacheWrite = tokens.cache?.write ?? 0
  }
  if (cost !== undefined) usage.cost = cost
  return usage
}

export function createV1Port(rawClient: unknown): HostPort {
  const client = rawClient as AnyClient
  return {
    kind: "v1",

    async readRecentMessages(sessionID: string, limit: number): Promise<HostMessage[]> {
      const data = unwrap(await client.session.messages({ path: { id: sessionID }, query: { limit } }))
      if (!Array.isArray(data)) return []
      const out: HostMessage[] = []
      for (const entry of data) {
        if (!entry || typeof entry !== "object") continue
        const info = (entry as { info?: Record<string, unknown> }).info
        const parts = (entry as { parts?: unknown }).parts
        if (!info || typeof info !== "object") continue
        const role = info["role"]
        if (role !== "user" && role !== "assistant") continue
        const id = typeof info["id"] === "string" ? info["id"] : ""
        const text = textOfParts(parts)
        const message: HostMessage = {
          id,
          role,
          text,
          hasToolCalls: role === "assistant" ? partsHaveTool(parts) : false,
          pluginOwned: role === "user" ? isPluginOwnedText(text) : false,
        }
        if (role === "assistant") message.usage = usageFromInfo(info)
        if (typeof info["agent"] === "string") message.agent = info["agent"]
        if (typeof info["providerID"] === "string") message.providerID = info["providerID"]
        if (typeof info["modelID"] === "string") message.modelID = info["modelID"]
        out.push(message)
      }
      return out
    },

    async sendPrompt(input: SendPromptInput): Promise<void> {
      const body: Record<string, unknown> = { parts: [{ type: "text", text: input.text }] }
      if (input.agent !== undefined) body["agent"] = input.agent
      if (input.model !== undefined) body["model"] = input.model
      if (typeof client.session.promptAsync === "function") {
        await client.session.promptAsync({ path: { id: input.sessionID }, body })
      } else {
        void client.session.prompt({ path: { id: input.sessionID }, body }).catch(() => {})
      }
    },

    storage: {
      // V1 persistence is file-based and owned by the plugin; this is unused.
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    },

    async log(level: LogLevel, message: string, extra?: Record<string, unknown>): Promise<void> {
      try {
        await client.app.log({
          body: {
            service: "opencode-goal-loop",
            level,
            message,
            ...(extra ? { extra } : {}),
          },
        })
      } catch {
        // logging must never break the loop
      }
    },

    async toast(message: string, variant = "info"): Promise<void> {
      try {
        await client.tui?.showToast?.({ body: { message, variant } })
      } catch {
        // ignore
      }
    },

    async getSession(sessionID: string): Promise<SessionInfoLite | undefined> {
      try {
        const data = unwrap(await client.session.get({ path: { id: sessionID } }))
        if (!data || typeof data !== "object") return { id: sessionID }
        const s = data as { title?: unknown; agent?: unknown }
        const info: SessionInfoLite = { id: sessionID }
        if (typeof s.title === "string") info.title = s.title
        if (typeof s.agent === "string") info.agent = s.agent
        return info
      } catch {
        return { id: sessionID }
      }
    },

    async listChildren(sessionID: string): Promise<Array<{ id: string; active: boolean }>> {
      try {
        if (typeof client.session.children !== "function") return []
        const data = unwrap(await client.session.children({ path: { id: sessionID } }))
        if (!Array.isArray(data)) return []
        return data
          .map((c) => (c && typeof c === "object" ? (c as { id?: unknown }).id : undefined))
          .filter((v): v is string => typeof v === "string")
          .map((id) => ({ id, active: false }))
      } catch {
        return []
      }
    },

    now(): number {
      return Date.now()
    },
  }
}
