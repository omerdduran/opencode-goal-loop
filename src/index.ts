/**
 * opencode-goal-loop
 *
 * A durable, guarded goal loop for OpenCode. This single default export
 * supports both host generations from one package:
 *
 * - OpenCode V1 resolves `id` and calls `server(input, options)`.
 * - OpenCode V2 resolves `id` and calls `setup(context)`.
 */

import { PLUGIN_ID } from "./core/constants.ts"
import { createV1Plugin } from "./v1/plugin.ts"
import { setupV2 } from "./v2/plugin.ts"

const goalLoopPlugin = {
  id: PLUGIN_ID,
  server: createV1Plugin,
  setup: setupV2,
}

export default goalLoopPlugin
export { createV1Plugin, setupV2 }
export type { PluginOptions, LimitOverrides, Goal, SessionState } from "./core/index.ts"
