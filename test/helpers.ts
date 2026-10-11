import { isPluginOwnedText } from "../src/core/constants.ts"
import type {
  HostMessage,
  HostPort,
  SendPromptInput,
  SessionInfoLite,
} from "../src/ports.ts"

export function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  extra: Partial<HostMessage> = {},
): HostMessage {
  const result: HostMessage = {
    id,
    role,
    text,
    hasToolCalls: extra.hasToolCalls ?? false,
    pluginOwned: extra.pluginOwned ?? isPluginOwnedText(text),
  }
  if (extra.usage !== undefined) result.usage = extra.usage
  if (extra.agent !== undefined) result.agent = extra.agent
  if (extra.providerID !== undefined) result.providerID = extra.providerID
  if (extra.modelID !== undefined) result.modelID = extra.modelID
  return result
}

export class FakeHost implements HostPort {
  readonly kind = "v1" as const
  messages: HostMessage[] = []
  sent: SendPromptInput[] = []
  logs: Array<{ level: string; message: string }> = []
  toasts: string[] = []
  currentTime = 1_000_000
  titles: Array<{ sessionID: string; title: string }> = []
  children: Array<{ id: string; active: boolean }> = []
  private values = new Map<string, unknown>()
  failNextSend = false

  storage = {
    get: async (key: string): Promise<unknown> => this.values.get(key),
    set: async (key: string, value: unknown): Promise<void> => {
      this.values.set(key, value)
    },
    remove: async (key: string): Promise<void> => {
      this.values.delete(key)
    },
  }

  async readRecentMessages(_sessionID: string, limit: number): Promise<HostMessage[]> {
    return this.messages.slice(-limit)
  }

  async sendPrompt(input: SendPromptInput): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false
      throw new Error("boom")
    }
    this.sent.push(input)
  }

  async log(level: string, message: string): Promise<void> {
    this.logs.push({ level, message })
  }

  async toast(message: string): Promise<void> {
    this.toasts.push(message)
  }

  async getSession(sessionID: string): Promise<SessionInfoLite | undefined> {
    return { id: sessionID }
  }

  async setTitle(sessionID: string, title: string): Promise<void> {
    this.titles.push({ sessionID, title })
  }

  async listChildren(): Promise<Array<{ id: string; active: boolean }>> {
    return this.children
  }

  now(): number {
    return this.currentTime
  }
}
