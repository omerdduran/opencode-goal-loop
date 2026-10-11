import { test } from "node:test"
import assert from "node:assert/strict"
import { parseOutcome } from "../src/core/completion.ts"

test("complete with adjacent evidence is honored", () => {
  const text =
    "Did the work.\n[goal:evidence] ran npm test (83 passing)\n[goal:complete]"
  const o = parseOutcome(text)
  assert.equal(o.kind, "complete")
  assert.equal(o.evidence, "ran npm test (83 passing)")
})

test("bare brackets are accepted", () => {
  const o = parseOutcome("goal:evidence fixed it\ngoal:complete")
  assert.equal(o.kind, "complete")
  assert.equal(o.evidence, "fixed it")
})

test("complete without evidence is invalid", () => {
  const o = parseOutcome("All done!\n[goal:complete]")
  assert.equal(o.kind, "invalid-complete")
})

test("stale / non-adjacent evidence is rejected", () => {
  const o = parseOutcome("[goal:evidence] earlier work\nsome other text\n[goal:complete]")
  assert.equal(o.kind, "invalid-complete")
})

test("blocked with concrete reason is honored", () => {
  const o = parseOutcome("I need a production API token I don't have.\n[goal:blocked]")
  assert.equal(o.kind, "blocked")
  assert.match(o.blocker, /production API token/)
})

test("blocked without reason is invalid", () => {
  const o = parseOutcome("[goal:blocked]")
  assert.equal(o.kind, "invalid-blocked")
})

test("normal text yields none", () => {
  assert.equal(parseOutcome("still working on it").kind, "none")
})

test("historical two-line evidence form is accepted", () => {
  const o = parseOutcome("verified the build\n[goal:evidence]\n[goal:complete]")
  assert.equal(o.kind, "complete")
  assert.equal(o.evidence, "verified the build")
})

test("blockquote-prefixed markers are recognized", () => {
  assert.equal(parseOutcome("> [goal:evidence] checked\n> [goal:complete]").kind, "complete")
})
