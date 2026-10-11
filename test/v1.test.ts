import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { PluginInput } from "@opencode-ai/plugin"
import { createV1Plugin } from "../src/v1/plugin.ts"
import { resetLifecycle } from "../src/lifecycle.ts"

beforeEach(() => resetLifecycle())

interface MessageEntry {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

function makeFakeClient(initial: MessageEntry[] = []) {
  const messages: MessageEntry[] = initial
  const prompt: unknown[] = []
  const promptAsync: unknown[] = []
  const toasts: unknown[] = []
  const client = {
    session: {
      messages: async () => ({ data: messages }),
      prompt: async (input: unknown) => {
        prompt.push(input)
        return { data: {} }
      },
      promptAsync: async (input: unknown) => {
        promptAsync.push(input)
        return {}
      },
      get: async () => ({ data: { title: "session" } }),
    },
    app: { log: async () => ({}) },
    tui: {
      showToast: async (input: unknown) => {
        toasts.push(input)
        return {}
      },
    },
  }
  return { client, messages, prompt, promptAsync, toasts }
}

function makeInput(client: unknown): PluginInput {
  return {
    client,
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as unknown as PluginInput
}

test("V1 command hook replaces the command turn with a work instruction", async () => {
  const fake = makeFakeClient()
  const hooks = await createV1Plugin(makeInput(fake.client), { persistState: false, minDelayMs: 0 })
  const output = { parts: [{ id: "p", sessionID: "s1", messageID: "m", type: "text", text: "/goal x" }] }
  await hooks["command.execute.before"]!({ command: "goal", sessionID: "s1", arguments: "fix the tests" }, output as never)
  assert.match((output.parts[0] as { text: string }).text, /\[goal-loop:init\]/)
  assert.match((output.parts[0] as { text: string }).text, /fix the tests/)
})

test("V1 idle event triggers an auto-continuation", async () => {
  const fake = makeFakeClient()
  const hooks = await createV1Plugin(makeInput(fake.client), { persistState: false, minDelayMs: 0 })

  const output = { parts: [{ id: "p", sessionID: "s1", messageID: "m", type: "text", text: "/goal x" }] }
  await hooks["command.execute.before"]!({ command: "goal", sessionID: "s1", arguments: "fix the tests" }, output as never)
  const workInstruction = (output.parts[0] as { text: string }).text

  fake.messages.push({ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: workInstruction }] })
  fake.messages.push({
    info: {
      id: "a1",
      role: "assistant",
      tokens: { input: 10, output: 120, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.01,
    },
    parts: [{ type: "text", text: "working" }, { type: "tool", tool: "bash" }],
  })

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as never)
  assert.equal(fake.promptAsync.length, 1)
  const sent = fake.promptAsync[0] as { body: { parts: Array<{ text: string }> } }
  assert.match(sent.body.parts[0]!.text, /\[goal-loop:continue\]/)
})

test("V1 completion in history archives the goal and stops continuing", async () => {
  const fake = makeFakeClient()
  const hooks = await createV1Plugin(makeInput(fake.client), { persistState: false, minDelayMs: 0 })
  const output = { parts: [{ id: "p", sessionID: "s1", messageID: "m", type: "text", text: "/goal x" }] }
  await hooks["command.execute.before"]!({ command: "goal", sessionID: "s1", arguments: "fix tests" }, output as never)
  const workInstruction = (output.parts[0] as { text: string }).text

  fake.messages.push({ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: workInstruction }] })
  fake.messages.push({
    info: { id: "a1", role: "assistant", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [
      { type: "text", text: "done\n[goal:evidence] ran the suite\n[goal:complete]" },
      { type: "tool", tool: "bash" },
    ],
  })

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as never)
  assert.equal(fake.promptAsync.length, 0)
})

test("V1 config hook registers the goal command", async () => {
  const fake = makeFakeClient()
  const hooks = await createV1Plugin(makeInput(fake.client), { persistState: false })
  const config: { command?: Record<string, unknown> } = {}
  await hooks.config!(config as never)
  assert.ok(config.command && config.command["goal"])
})

test("V1 compaction hook injects goal context and suppresses autocontinue", async () => {
  const fake = makeFakeClient()
  const hooks = await createV1Plugin(makeInput(fake.client), { persistState: false })
  const cmdOutput = { parts: [{ id: "p", sessionID: "s1", messageID: "m", type: "text", text: "/goal x" }] }
  await hooks["command.execute.before"]!(
    { command: "goal", sessionID: "s1", arguments: "keep me visible" },
    cmdOutput as never,
  )

  const compactOutput = { context: [] as string[] }
  await hooks["experimental.session.compacting"]!({ sessionID: "s1" }, compactOutput as never)
  assert.ok(compactOutput.context.some((c) => c.includes("keep me visible")))

  const autoOutput = { enabled: true }
  await hooks["experimental.compaction.autocontinue"]!({ sessionID: "s1" } as never, autoOutput as never)
  assert.equal(autoOutput.enabled, false)
})
