/**
 * Shared constant markers and defaults for the plugin.
 *
 * These strings form a small, stable protocol between the plugin and the
 * model / host. Keep them centralized so both the V1 and V2 adapters agree.
 */

/** Prefix embedded in every plugin-generated continuation turn. */
export const CONTINUE_MARKER = "[goal-loop:continue]"

/** Prefix embedded in every plugin-generated control/command result turn. */
export const CONTROL_MARKER = "[goal-loop:control]"

/** Prefix embedded in the initial work-instruction turn after a goal is set. */
export const INIT_MARKER = "[goal-loop:init]"

/** Evidence marker the assistant must emit before a completion claim. */
export const EVIDENCE_MARKER = "[goal:evidence]"

/** Completion marker. Only honored when preceded by adjacent evidence. */
export const COMPLETE_MARKER = "[goal:complete]"

/** Blocker marker. Only honored when a concrete blocker precedes it. */
export const BLOCKED_MARKER = "[goal:blocked]"

/** Accepted bare (bracketless) variants — some models drop the brackets. */
export const BARE_COMPLETE = "goal:complete"
export const BARE_BLOCKED = "goal:blocked"
export const BARE_EVIDENCE = "goal:evidence"

/** Plugin id used by the host to identify this plugin. */
export const PLUGIN_ID = "opencode-goal-loop"

/** Default slash command name. */
export const DEFAULT_COMMAND_NAME = "goal"

/** Agent names treated as planning-only by default. */
export const DEFAULT_RESTRICTED_AGENTS = ["plan"]

/**
 * A marker that makes plugin-owned turns identifiable when scanning history.
 * Any assistant/user text starting with one of these is plugin-owned and must
 * never be treated as a human intervention.
 */
export function isPluginOwnedText(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith(CONTINUE_MARKER) || t.startsWith(CONTROL_MARKER) || t.startsWith(INIT_MARKER)
  )
}
