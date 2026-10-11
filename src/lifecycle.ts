/**
 * Cross-entrypoint coordination.
 *
 * A package may expose both `server` (V1) and `setup` (V2). Depending on the
 * OpenCode build, one or both entrypoints can be invoked in a single process
 * (e.g. some 1.18.x builds call both, with an empty V2 context). To guarantee
 * the goal engine initializes exactly once, activation is claimed: the first
 * entrypoint to activate wins and the other stands down.
 *
 * `setup` additionally refuses to activate when the context does not look like a
 * real V2 host (no `ctx.app.version`), so a transitional build's empty setup
 * call can never claim activation away from `server`.
 */

let claimed = false

/** Try to claim activation. Returns false if another entrypoint already owns it. */
export function claimActivation(): boolean {
  if (claimed) return false
  claimed = true
  return true
}

export function isClaimed(): boolean {
  return claimed
}

/** Test hook. */
export function resetLifecycle(): void {
  claimed = false
}
