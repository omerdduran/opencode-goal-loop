/**
 * The platform abstraction the core engine talks to. Adapters for OpenCode V1
 * and V2 implement this; the core never imports a host SDK.
 */

import type { Usage } from "./core/types.ts"

export interface HostMessage {
  id: string
  role: "user" | "assistant"
  text: string
  /** True if the assistant message invoked at least one tool. */
  hasToolCalls: boolean
  usage?: Partial<Usage>
  providerID?: string
  modelID?: string
  agent?: string
  /** True when this message was produced by the plugin itself. */
  pluginOwned: boolean
}

export interface SendPromptInput {
  sessionID: string
  text: string
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
}

export interface HostStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export interface SessionInfoLite {
  id: string
  title?: string
  agent?: string
}

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface HostPort {
  readonly kind: "v1" | "v2"

  /** Read the most recent messages for a session, oldest-to-newest. */
  readRecentMessages(sessionID: string, limit: number): Promise<HostMessage[]>

  /** Send a user prompt and let the host run the assistant turn. */
  sendPrompt(input: SendPromptInput): Promise<void>

  storage: HostStorage

  log(level: LogLevel, message: string, extra?: Record<string, unknown>): Promise<void>
  toast(message: string, variant?: "info" | "success" | "warning" | "error"): Promise<void>

  getSession(sessionID: string): Promise<SessionInfoLite | undefined>
  setTitle?(sessionID: string, title: string): Promise<void>

  /** Active child sessions, used to defer continuation while subagents run. */
  listChildren?(sessionID: string): Promise<Array<{ id: string; active: boolean }>>

  /** Current wall-clock time in ms. */
  now(): number
}
