import { test } from "node:test"
import assert from "node:assert/strict"
import { createV1Plugin } from "../src/v1/plugin.ts"
import { setupV2 } from "../src/v2/plugin.ts"
import { claimActivation, isClaimed, resetLifecycle } from "../src/lifecycle.ts"

test("setupV2 no-ops and does not claim activation on a V1-style context", async () => {
  resetLifecycle()
  const cleanup = await setupV2({})
  assert.equal(typeof cleanup, "function")
  assert.equal(isClaimed(), false)
})

test("createV1Plugin stands down when another entrypoint owns the process", async () => {
  resetLifecycle()
  claimActivation()
  const hooks = await createV1Plugin({ client: {} } as never, { persistState: false })
  assert.deepEqual(hooks, {})
  resetLifecycle()
})
