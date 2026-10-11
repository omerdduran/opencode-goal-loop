import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { setupV2 } from "../src/v2/plugin.ts"
import { resetLifecycle } from "../src/lifecycle.ts"

beforeEach(() => resetLifecycle())

class AsyncQueue<T> {
  private items: T[] = []
  private waiters: Array<(value: T | undefined) => void> = []
  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(value)
    else this.items.push(value)
  }
  async next(): Promise<T | undefined> {
    if (this.items.length > 0) return this.items.shift()
    return new Promise<T | undefined>((resolve) => this.waiters.push(resolve))
  }
}

interface CommandDef {
  name: string
  execute: (invocation: { sessionID: string; prompt?: { text?: string } }) => Promise<void>
}

interface ToolDef {
  name: string
  input: unknown
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>
}

function makeV2Context() {
  const values = new Map<string, unknown>()
  const prompts: Array<Record<string, unknown>> = []
  const hooks = new Map<string, (event: unknown) => unknown>()
  const queue = new AsyncQueue<{ type?: string; data?: { sessionID?: string } }>()
  let commandDef: CommandDef | undefined
  const tools: ToolDef[] = []
  const messages: unknown[] = []

  const ctx = {
    app: { version: "2.0.26" },
    location: { directory: "/tmp/project" },
    options: {},
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, value)
      },
      remove: async (key: string) => {
        values.delete(key)
      },
    },
    session: {
      context: async () => messages,
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return {}
      },
      update: async () => ({}),
      hook: async (name: string, cb: (event: unknown) => unknown) => {
        hooks.set(name, cb)
        return { dispose: async () => {} }
      },
    },
    command: {
      transform: async (cb: (editor: { add: (def: unknown) => void }) => void) => {
        cb({ add: (def: unknown) => (commandDef = def as CommandDef) })
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async (cb: (editor: { add: (t: unknown) => void }) => void) => {
        cb({ add: (t: unknown) => tools.push(t as ToolDef) })
        return { dispose: async () => {} }
      },
    },
    agent: { transform: async () => ({ dispose: async () => {} }) },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return { next: () => queue.next().then((value) => ({ value, done: value === undefined })) }
        },
      }),
    },
  }
  return { ctx, values, prompts, hooks, queue, tools, messages, get commandDef() { return commandDef } }
}

function contextHookEvent(sessionID: string, agent = "build") {
  return { sessionID, agent, model: { providerID: "p", id: "m" }, system: [] as Array<{ type: string; text: string }>, messages: [], options: {} }
}

test("V2 setup registers command, tools, and hooks", async () => {
  const fake = makeV2Context()
  const cleanup = await setupV2(fake.ctx)
  assert.equal(typeof cleanup, "function")
  assert.ok(fake.commandDef)
  assert.ok(fake.tools.find((t) => t.name === "goal_set"))
  assert.ok(fake.hooks.has("context"))
  assert.ok(fake.hooks.has("compaction"))
})

test("V2 command sets a goal and submits the work instruction", async () => {
  const fake = makeV2Context()
  await setupV2(fake.ctx)
  await fake.commandDef!.execute({ sessionID: "s1", prompt: { text: "fix the tests" } })
  assert.equal(fake.prompts.length, 1)
  const text = fake.prompts[0]!["text"] as string
  assert.match(text, /\[goal-loop:init\]/)
  assert.match(text, /fix the tests/)
})

test("V2 context hook injects the active goal into the system prompt", async () => {
  const fake = makeV2Context()
  await setupV2(fake.ctx)
  await fake.commandDef!.execute({ sessionID: "s1", prompt: { text: "keep me" } })
  const event = contextHookEvent("s1")
  fake.hooks.get("context")!(event)
  assert.ok(event.system.some((p) => p.text.includes("keep me")))
})

test("V2 idle event drives an auto-continuation", async () => {
  const fake = makeV2Context()
  await setupV2(fake.ctx)
  await fake.commandDef!.execute({ sessionID: "s1", prompt: { text: "fix tests" } })
  const workInstruction = fake.prompts[0]!["text"] as string

  fake.messages.push({ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: workInstruction }] })
  fake.messages.push({
    info: { id: "a1", role: "assistant", tokens: { input: 5, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{ type: "text", text: "working" }, { type: "tool" }],
  })

  fake.queue.push({ type: "session.idle", data: { sessionID: "s1" } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fake.prompts.length, 2)
  assert.match(fake.prompts[1]!["text"] as string, /\[goal-loop:continue\]/)
})

test("V2 tool goal_status returns a JSON envelope", async () => {
  const fake = makeV2Context()
  await setupV2(fake.ctx)
  await fake.commandDef!.execute({ sessionID: "s1", prompt: { text: "a goal" } })
  const statusTool = fake.tools.find((t) => t.name === "goal_status")!
  const result = await statusTool.execute({}, { sessionID: "s1" })
  const parsed = JSON.parse(result.content) as { ok: boolean; status: string }
  assert.equal(parsed.ok, true)
  assert.match(parsed.status, /a goal/)
})

test("V2 continuation sends only sessionID and text (no rejected agent/model keys)", async () => {
  const fake = makeV2Context()
  await setupV2(fake.ctx)
  await fake.commandDef!.execute({ sessionID: "s1", prompt: { text: "fix tests" } })
  const workInstruction = fake.prompts[0]!["text"] as string

  // The context hook records the agent/model on the goal.
  fake.hooks.get("context")!(contextHookEvent("s1"))

  fake.messages.push({ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: workInstruction }] })
  fake.messages.push({
    info: { id: "a1", role: "assistant", tokens: { input: 5, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{ type: "text", text: "working" }, { type: "tool" }],
  })

  fake.queue.push({ type: "session.idle", data: { sessionID: "s1" } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const body = fake.prompts[1]!
  assert.match(body["text"] as string, /\[goal-loop:continue\]/)
  assert.equal("agent" in body, false)
  assert.equal("model" in body, false)
})

test("V2 persistence survives across setups via storage", async () => {
  const fake = makeV2Context()
  const cleanup = await setupV2(fake.ctx)
  await fake.commandDef!.execute({ sessionID: "s1", prompt: { text: "persist me" } })
  await cleanup()

  const fake2 = makeV2Context()
  fake2.ctx.storage = fake.ctx.storage
  resetLifecycle() // simulate a fresh process loading the plugin again
  await setupV2(fake2.ctx)
  fake2.messages.push({ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "[goal-loop:init] x" }] })
  const event = contextHookEvent("s1")
  fake2.hooks.get("context")!(event)
  // Recovered goals load paused, so the block still references the objective.
  assert.ok(event.system.some((p) => p.text.includes("persist me")))
})
