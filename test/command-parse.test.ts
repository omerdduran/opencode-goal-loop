import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCommand } from "../src/core/command-parse.ts"

test("bare objective defaults to set", () => {
  const c = parseCommand("fix the failing tests")
  assert.equal(c.action, "set")
  assert.equal(c.objective, "fix the failing tests")
})

test("subcommands are recognized", () => {
  for (const name of ["pause", "resume", "clear", "status", "list", "history"]) {
    assert.equal(parseCommand(name).action, (name === "clear" ? "clear" : name))
  }
  assert.equal(parseCommand("stop").action, "clear")
  assert.equal(parseCommand("off").action, "clear")
})

test("numeric flags parse", () => {
  const c = parseCommand("fix tests --max-turns 20 --max-minutes 30 --max-tokens 400000")
  assert.equal(c.limits.maxTurns, 20)
  assert.equal(c.limits.maxDurationMs, 30 * 60_000)
  assert.equal(c.limits.maxTokens, 400000)
  assert.equal(c.objective, "fix tests")
})

test("flag=value form works", () => {
  const c = parseCommand("fix tests --max-turns=20 --budget=100k")
  assert.equal(c.limits.maxTurns, 20)
  assert.equal(c.limits.maxTokens, 100_000)
})

test("budget accepts k/m suffixes", () => {
  assert.equal(parseCommand("x --budget 1.5m").limits.maxTokens, 1_500_000)
  assert.equal(parseCommand("x --budget 50k").limits.maxTokens, 50_000)
})

test("quoted success and constraints", () => {
  const c = parseCommand('ship it --success "tests pass and changelog updated" --constraints "do not touch API"')
  assert.equal(c.successCriteria, "tests pass and changelog updated")
  assert.equal(c.constraints, "do not touch API")
  assert.equal(c.objective, "ship it")
})

test("mode validates", () => {
  assert.equal(parseCommand("x --mode ordered").mode, "ordered")
  assert.match(parseCommand("x --mode weird").error ?? "", /Invalid --mode/)
})

test("unknown flag is reported", () => {
  const c = parseCommand("x --bogus 1")
  assert.match(c.error ?? "", /Unknown flag/)
})

test("fenced code keeps dashes literal", () => {
  const c = parseCommand("run ```pytest --maxfail=1``` and fix")
  assert.equal(c.objective, "run ```pytest --maxfail=1``` and fix")
  assert.equal(c.limits.maxTurns, undefined)
  assert.equal(c.error, undefined)
})

test("missing value is reported", () => {
  const c = parseCommand("x --max-turns")
  assert.match(c.error ?? "", /Missing value/)
})

test("sequence splits on semicolons", () => {
  const c = parseCommand("sequence a; b; c")
  assert.equal(c.action, "sequence")
  assert.deepEqual(c.sequence, ["a", "b", "c"])
})

test("focus parses index", () => {
  const c = parseCommand("focus 2")
  assert.equal(c.action, "focus")
  assert.equal(c.focusIndex, 2)
})
