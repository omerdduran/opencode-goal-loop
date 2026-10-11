/**
 * A minimal, duck-typed description of the OpenCode V2 plugin context.
 *
 * We deliberately do NOT import `@opencode/plugin` types: that would pull a
 * large Effect-based dependency tree into this package and force it on V1
 * consumers. Only the members the goal engine touches are declared here.
 */

export interface V2SystemPart {
  type: "text"
  text: string
}

export interface V2RequestEvent {
  readonly sessionID: string
  readonly agent?: string
  readonly model?: { providerID: string; id?: string; modelID?: string }
  system: V2SystemPart[]
  messages: unknown[]
  options: Record<string, unknown>
  tools?: Record<string, unknown>
  result?: unknown
}

export interface V2ToolContext {
  readonly sessionID: string
  readonly signal?: AbortSignal
  progress?(update: unknown): Promise<void>
}

export interface V2Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export interface V2Event {
  type?: string
  data?: { sessionID?: string }
  properties?: { sessionID?: string }
}

export interface V2Context {
  readonly app?: { version?: string; name?: string; channel?: string }
  readonly location?: { directory?: string; project?: unknown }
  readonly options?: Record<string, unknown>

  readonly session: {
    context(input: { sessionID: string }): Promise<readonly unknown[]>
    prompt(input: Record<string, unknown>): Promise<unknown>
    update(input: { sessionID: string; title?: string }): Promise<unknown>
    hook(
      name: string,
      callback: (event: V2RequestEvent) => void | Promise<void>,
      options?: unknown,
    ): Promise<{ dispose(): Promise<void> } | void>
  }

  readonly command: {
    transform(callback: (editor: { add(definition: unknown): void }) => void): Promise<unknown>
  }

  readonly agent: {
    transform(callback: (editor: unknown) => void): Promise<unknown>
  }

  readonly tool: {
    transform(
      callback: (editor: {
        add(tool: unknown): void
        namespace?(ns: unknown): void
        list?(): readonly unknown[]
      }) => void,
    ): Promise<unknown>
  }

  readonly storage: V2Storage

  readonly event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event>
  }
}
