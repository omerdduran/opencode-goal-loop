// Local dev loader for opencode-goal-loop.
//
// OpenCode auto-discovers plugin files under `.opencode/plugins/` and calls the
// default export. This re-exports the built plugin so both OpenCode 1.x (1.18+)
// and 2.x load the real artifact when you run `opencode` from this repo root.
//
// Build first:  npm run build
export { default } from "../../dist/index.js"
