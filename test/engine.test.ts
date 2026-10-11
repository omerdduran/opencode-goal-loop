import { test } from "node:test"
import assert from "node:assert/strict"
import { Engine } from "../src/core/engine.ts"
import { normalizeOptions } from "../src/core/options.ts"
import { FakeHost, message } from "./helpers.ts"

function setup(extra: Record<string, unknown> = {}): { host: FakeHost; engine: Engine } {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ minDelayMs: 0, ...extra }), host)
  return { host, engine }
}

/** Seed the session with the initial work-instruction turn and one tool-using reply. */
async function seedWorkingGoal(host: FakeHost, engine: Engine, sessionID = "s1"): Promise<void> {
  const out = await engine.runCommand(sessionID, "fix the failing tests")
  host.messages.push(message("m0", "user", out.prompt))
  host.messages.push(
    message("a1", "assistant", "Running the tests now.", { hasToolCalls: true, usage: { output: 120 } }),
  )
}

test("setting a goal returns a work instruction with the init marker", async () => {
  const { engine } = setup()
  const out = await engine.runCommand("s1", "fix tests")
  assert.equal(out.control, false)
  assert.match(out.prompt, /\[goal-loop:init\]/)
  assert.equal(engine.store.focused("s1")?.condition, "fix tests")
})

test("idle after a working turn sends exactly one continuation", async () => {
  const { host, engine } = setup()
  await seedWorkingGoal(host, engine)
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 1)
  assert.match(host.sent[0]!.text, /\[goal-loop:continue\]/)
  assert.equal(engine.store.focused("s1")?.turnCount, 1)
})

test("the same assistant turn is not continued twice", async () => {
  const { host, engine } = setup()
  await seedWorkingGoal(host, engine)
  await engine.onIdle("s1")
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 1)
})

test("evidence-gated completion archives the goal and stops", async () => {
  const { host, engine } = setup()
  await seedWorkingGoal(host, engine)
  await engine.onIdle("s1")
  host.messages.push(
    message(
      "a2",
      "assistant",
      "All tests pass.\n[goal:evidence] ran npm test (83 passing)\n[goal:complete]",
      { hasToolCalls: true, usage: { output: 90 } },
    ),
  )
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 1)
  assert.equal(engine.store.focused("s1"), undefined)
  assert.equal(engine.store.session("s1").archived.length, 1)
})

test("completion without evidence is rejected and re-prompted", async () => {
  const { host, engine } = setup({ noToolCallTurnsBeforePause: 0 })
  await seedWorkingGoal(host, engine)
  host.messages.push(
    message("a2", "assistant", "Done!\n[goal:complete]", { hasToolCalls: true, usage: { output: 90 } }),
  )
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 1)
  assert.match(host.sent[0]!.text, /without adjacent evidence/)
})

test("a concrete blocker pauses the goal", async () => {
  const { host, engine } = setup()
  await seedWorkingGoal(host, engine)
  host.messages.push(
    message("a2", "assistant", "I need a production API token.\n[goal:blocked]", {
      hasToolCalls: true,
      usage: { output: 80 },
    }),
  )
  await engine.onIdle("s1")
  const goal = engine.store.focused("s1")
  assert.equal(goal?.status, "blocked")
  assert.equal(host.sent.length, 0)
})

test("a human message after continuation pauses the goal", async () => {
  const { host, engine } = setup()
  await seedWorkingGoal(host, engine)
  await engine.onIdle("s1") // continuation sent
  host.messages.push(message("u2", "user", "actually, stop and do X instead"))
  host.messages.push(message("a3", "assistant", "Okay.", { hasToolCalls: false, usage: { output: 10 } }))
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 1)
  assert.equal(engine.store.focused("s1")?.status, "paused")
  assert.equal(engine.store.focused("s1")?.stopReason, "user intervention")
})

test("hard turn limit sends a wrap-up then pauses", async () => {
  const { host, engine } = setup({ maxTurns: 1 })
  await seedWorkingGoal(host, engine)
  await engine.onIdle("s1") // turn 1 => now at limit
  assert.equal(host.sent.length, 1)
  // New assistant turn after the continuation.
  host.messages.push(
    message("a2", "assistant", "still going", { hasToolCalls: true, usage: { output: 120 } }),
  )
  await engine.onIdle("s1") // exhausted -> wrap-up continuation
  assert.equal(host.sent.length, 2)
  assert.match(host.sent[1]!.text, /wrap-up turn/i)
  host.messages.push(
    message("a3", "assistant", "summary", { hasToolCalls: true, usage: { output: 120 } }),
  )
  await engine.onIdle("s1") // wrap-up already sent -> pause
  assert.equal(engine.store.focused("s1")?.status, "paused")
})

test("pause and resume round-trips", async () => {
  const { engine } = setup()
  await engine.runCommand("s1", "a goal")
  await engine.runCommand("s1", "pause")
  assert.equal(engine.store.focused("s1")?.status, "paused")
  await engine.runCommand("s1", "resume")
  const goal = engine.store.focused("s1")
  assert.equal(goal?.status, "active")
  assert.equal(goal?.turnCount, 0)
})

test("clear removes live goals", async () => {
  const { engine } = setup()
  await engine.runCommand("s1", "a goal")
  await engine.runCommand("s1", "clear")
  assert.equal(engine.store.session("s1").goals.length, 0)
})

test("status reports the active goal", async () => {
  const { engine } = setup()
  await engine.runCommand("s1", "ship the release")
  const status = await engine.runCommand("s1", "status")
  assert.equal(status.control, true)
  assert.match(status.prompt, /Active goal: ship the release/)
})

test("sequence creates an ordered queue and focuses the first", async () => {
  const { engine } = setup()
  const out = await engine.runCommand("s1", "sequence build; test; ship")
  assert.equal(out.control, false)
  const state = engine.store.session("s1")
  assert.equal(state.ordered, true)
  assert.equal(state.goals.length, 3)
  assert.equal(engine.store.focused("s1")?.condition, "build")
})

test("a restricted agent holds the goal", async () => {
  const { engine } = setup()
  await engine.runCommand("s1", "do a thing", "plan")
  const goal = engine.store.focused("s1")
  assert.equal(goal?.status, "paused")
  assert.equal(goal?.stopReason, "plan agent active")
})

test("compaction context includes the objective", async () => {
  const { engine } = setup()
  await engine.runCommand("s1", "keep the goal visible")
  const ctx = engine.compactionContext("s1")
  assert.match(ctx ?? "", /keep the goal visible/)
  assert.equal(engine.shouldAutoContinueAfterCompaction("s1"), false)
})

test("repeated idle for the same talk-only turn does not inflate the stall counter (no false pause)", async () => {
  const { host, engine } = setup({ noToolCallTurnsBeforePause: 2, minDelayMs: 0 })
  const out = await engine.runCommand("s1", "a goal")
  host.messages.push(message("m0", "user", out.prompt))
  host.messages.push(message("a1", "assistant", "just thinking", { hasToolCalls: false, usage: { output: 60 } }))
  await engine.onIdle("s1")
  await engine.onIdle("s1")
  await engine.onIdle("s1")
  assert.equal(engine.store.focused("s1")?.status, "active")
  assert.equal(engine.store.focused("s1")?.noToolCallStreak, 1)
})

test("a failed continuation is retried on a later idle", async () => {
  const { host, engine } = setup({ minDelayMs: 0 })
  await seedWorkingGoal(host, engine)
  host.failNextSend = true
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 0)
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 1)
  assert.equal(engine.store.focused("s1")?.turnCount, 1)
})

test("sessionTitleStatus mirrors status into the session title", async () => {
  const { host, engine } = setup({ sessionTitleStatus: true })
  await engine.runCommand("s1", "ship the release")
  await engine.runCommand("s1", "pause")
  assert.ok(host.titles.length > 0)
  assert.match(host.titles[host.titles.length - 1]!.title, /ship the release/)
})

test("multi-turn loop auto-continues until a verified completion", async () => {
  const { host, engine } = setup({ minDelayMs: 0 })
  const out = await engine.runCommand("s1", "fix the bug")
  host.messages.push(message("m0", "user", out.prompt))

  for (let i = 1; i <= 3; i++) {
    host.currentTime += 1_000
    host.messages.push(
      message(`a${i}`, "assistant", `working step ${i}`, {
        hasToolCalls: true,
        usage: { output: 120 },
      }),
    )
    await engine.onIdle("s1")
  }
  assert.equal(host.sent.length, 3)
  assert.equal(engine.store.focused("s1")?.turnCount, 3)

  host.currentTime += 1_000
  host.messages.push(
    message("a4", "assistant", "Done.\n[goal:evidence] npm test passes\n[goal:complete]", {
      hasToolCalls: true,
      usage: { output: 80 },
    }),
  )
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 3)
  assert.equal(engine.store.focused("s1"), undefined)
  assert.equal(engine.store.session("s1").archived[0]!.evidence, "npm test passes")
})

test("resuming a paused goal continues on the next idle despite the prior claim", async () => {
  const { host, engine } = setup({ minDelayMs: 0 })
  await seedWorkingGoal(host, engine)
  await engine.onIdle("s1")
  host.messages.push(message("a2", "assistant", "working more", { hasToolCalls: true, usage: { output: 120 } }))
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 2)

  await engine.runCommand("s1", "pause")
  await engine.runCommand("s1", "resume")
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 3)
  assert.equal(engine.store.focused("s1")?.turnCount, 1)
})

test("editing the objective keeps the loop going", async () => {
  const { host, engine } = setup({ minDelayMs: 0 })
  await seedWorkingGoal(host, engine)
  await engine.onIdle("s1")
  host.messages.push(message("a2", "assistant", "working", { hasToolCalls: true, usage: { output: 120 } }))
  await engine.onIdle("s1")
  await engine.runCommand("s1", "edit a better objective")
  await engine.onIdle("s1")
  assert.equal(host.sent.length, 3)
})

test("responses to control commands do not count as stalled turns", async () => {
  const { host, engine } = setup({ minDelayMs: 0, noToolCallTurnsBeforePause: 1 })
  await seedWorkingGoal(host, engine)
  const status = await engine.runCommand("s1", "status")
  host.messages.push(message("c0", "user", status.prompt))
  host.messages.push(message("ca", "assistant", "Here is the status.", { hasToolCalls: false, usage: { output: 10 } }))
  await engine.onIdle("s1")
  assert.equal(engine.store.focused("s1")?.noToolCallStreak, 0)
  assert.equal(engine.store.focused("s1")?.status, "active")
})
