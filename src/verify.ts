#!/usr/bin/env node
/**
 * A small self-check / diagnostic binary. Run with `npx opencode-goal-loop`.
 */

import { PLUGIN_ID } from "./core/constants.ts"
import { parseCommand } from "./core/command-parse.ts"
import { parseOutcome } from "./core/completion.ts"
import { normalizeOptions } from "./core/options.ts"

interface Check {
  name: string
  run: () => boolean
}

const checks: Check[] = [
  {
    name: "command parsing (set + flags)",
    run: () => {
      const c = parseCommand("fix tests --max-turns 5")
      return c.action === "set" && c.limits.maxTurns === 5 && c.objective === "fix tests"
    },
  },
  {
    name: "evidence gate (complete requires evidence)",
    run: () => {
      const good = parseOutcome("[goal:evidence] ran tests\n[goal:complete]")
      const bad = parseOutcome("done\n[goal:complete]")
      return good.kind === "complete" && bad.kind === "invalid-complete"
    },
  },
  {
    name: "options normalization (clamps invalid values)",
    run: () => {
      const o = normalizeOptions({ maxTurns: -3, commandName: "/foo" })
      return o.maxTurns === 10 && o.commandName === "foo"
    },
  },
]

function main(): void {
  console.log(`${PLUGIN_ID} — self check`)
  console.log(`node: ${process.version}`)
  let failed = 0
  for (const check of checks) {
    let ok = false
    try {
      ok = check.run()
    } catch {
      ok = false
    }
    console.log(`${ok ? "ok  " : "FAIL"}  ${check.name}`)
    if (!ok) failed += 1
  }
  if (failed > 0) {
    console.error(`${failed} check(s) failed`)
    process.exit(1)
  }
  console.log("all checks passed")
}

main()
