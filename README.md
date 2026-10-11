# opencode-goal-loop

[![CI](https://github.com/omerdduran/opencode-goal-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/omerdduran/opencode-goal-loop/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-goal-loop.svg)](https://www.npmjs.com/package/opencode-goal-loop)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A durable, guarded **goal loop** for [OpenCode](https://opencode.ai). Set a
goal and the agent keeps working — auto-continuing whenever it goes idle — until
the goal is verified complete, a blocker is reported, or a safety limit is hit.
The goal survives context compaction.

One package supports **both OpenCode generations**:

- **V1** resolves `id` and calls `server(input, options)`.
- **V2** resolves `id` and calls `setup(context)`.

## Compatibility

Verified against real host processes (plugin loaded, command and all tools
registered, `setup`/`server` returned cleanly):

| OpenCode | Surface |
|---|---|
| 1.18.35 | `/goal` command hook, all hooks, 6 goal tools |
| 2.0.26 | `goal` command, all hooks, 6 goal tools |

V1 object entrypoints require OpenCode `1.18.29` or newer.

## Install

OpenCode installs npm plugins itself, so there is nothing to `npm install`.
Add the plugin to `opencode.json`:

**OpenCode 2** — the plugin registers its own `/goal` command:

```jsonc
{
  "plugins": ["opencode-goal-loop"]
}
```

**OpenCode 1** (1.18.29+):

```jsonc
{
  "plugin": ["opencode-goal-loop"]
}
```

The plugin adds the `goal` command through its `config` hook. If your setup does
not run the config hook, declare it explicitly:

```jsonc
{
  "plugin": ["opencode-goal-loop"],
  "command": {
    "goal": {
      "description": "Set a session-scoped goal and auto-continue until complete.",
      "template": "$ARGUMENTS"
    }
  }
}
```

Restart OpenCode after editing the config.

To use the pre-release build straight from GitHub (no npm publish needed):

```jsonc
{
  "plugins": ["github:omerdduran/opencode-goal-loop"]
}
```

npm installs the git dependency and runs the `prepare` script, which builds
`dist/` automatically.

## Usage

Set a goal:

```
/goal fix the failing tests and verify the suite passes
```

Override limits for a single goal:

```
/goal fix the failing tests --max-turns 20 --max-minutes 30 --max-tokens 400000 --max-cost 5
```

Add success criteria, constraints, and a mode:

```
/goal ship the release --success "tests pass and changelog updated" --constraints "do not touch the public API" --mode ordered
```

Other subcommands:

```
/goal status            # report state, budget, evidence, recent history
/goal history           # lifecycle history and latest checkpoint
/goal list              # numbered live goals
/goal pause             # stop auto-continue, keep the goal
/goal resume            # continue with a fresh budget window
/goal edit <objective>  # revise the objective in place
/goal add <objective>   # keep the current goal, focus a new one
/goal focus <n>         # switch the focused goal
/goal sequence a; b; c  # run objectives one at a time
/goal clear             # remove live goals (aliases: stop, off, reset, none, cancel)
```

### Flags

| Flag | Controls |
|---|---|
| `--max-turns <n>` | Auto-continue turn limit |
| `--max-minutes <n>` | Duration limit in minutes |
| `--max-duration-ms <n>` | Duration limit in milliseconds |
| `--max-tokens <n>` | Context token budget |
| `--budget <n>` | Token budget shorthand (`100k`, `1.5m`) |
| `--max-cost <n>` | Cumulative API cost budget (USD) |
| `--cooldown-ms <n>` | Minimum delay between continuations |
| `--no-progress-threshold <n>` | Output-token floor before pausing |
| `--no-progress-turns <n>` | Consecutive stalled turns before pausing |
| `--no-tool-turns <n>` | Consecutive tool-free turns before pausing |
| `--success <text>` | Success criteria (alias `--success-criteria`) |
| `--constraints <text>` | Constraints / non-goals (alias `--non-goals`) |
| `--mode <normal\|ordered>` | Preserve step order inside one objective |

Flags accept `--flag value` or `--flag=value`; quote multi-word values. To
include literal `--flags` in an objective, wrap them in a fenced code span.

## How it works

1. When you set a goal, the plugin stores it in per-session state and replaces
   the command turn with a deterministic work instruction containing the
   objective.
2. On every `session.idle`, while the goal is active and within limits, the
   plugin sends a continuation prompt. A durable claim on the source assistant
   turn prevents duplicate continuations.
3. The plugin stops when the assistant ends a response with a substantiated
   completion or blocker marker, or when a safety limit is reached.
4. On compaction, the goal summary is injected into the compaction context
   (reconstructed from persisted state, not chat memory). While a goal is
   active, OpenCode's generic post-compaction auto-continue is suppressed so it
   does not race this loop.
5. On V2 the active goal is also injected into every agent-loop model request
   through the `context` hook.

## Completion markers

```
[goal:evidence] ran npm test (83 passing), verified the build output
[goal:complete]
```

```
The deploy step needs a production API token I don't have.
[goal:blocked]
```

`[goal:complete]` is only honored when the immediately preceding line begins
with `[goal:evidence]` and contains a non-empty summary. A completion without
adjacent evidence is rejected and the loop re-prompts for it. `[goal:blocked]`
must be preceded by a concrete blocker. Natural-language phrases are ignored.

## Safety limits (defaults)

| Limit | Default |
|---|---|
| Auto-continue turns | 10 |
| Max duration | 15 minutes |
| Context tokens | 200,000 |
| API cost | off |
| Min delay between continues | 1.5 s |
| No-progress pause | < 50 output tokens, after 2 stalled turns |
| No-tool-call pause | after 2 tool-free turns |
| Budget wrap-up | 80% of a budget |

When a limit is reached the plugin sends one final wrap-up prompt, then pauses.
`/goal resume` opens a fresh budget window.

## Options

Plugin-level defaults (V2 object form shown; V1 uses the `[name, options]`
tuple):

```jsonc
{
  "plugins": [
    {
      "package": "opencode-goal-loop",
      "options": {
        "maxTurns": 10,
        "maxDurationMs": 900000,
        "maxTokens": 200000,
        "minDelayMs": 1500,
        "noProgressTurnsBeforePause": 2,
        "noToolCallTurnsBeforePause": 2,
        "persistState": true,
        "stateFilePath": ".opencode/goals/state.json",
        "restrictedAgents": ["plan"],
        "sessionTitleStatus": false
      }
    }
  ]
}
```

Other options: `commandName`, `registerCommand`, `registerTools`, `maxCostUsd`,
`maxRecentMessages`, `noInterruptOnUserMessage`, `noContinueWhileChildrenActive`,
`budgetWrapupRatio`, `maxPromptFailures`, `resultRetentionMs`,
`maxStoredResults`, `allowGoalExecutionFromPlan`, `lifecycleMessages`, `auditor`.

`sessionTitleStatus` mirrors live goal status into the session title (opt-in,
cosmetic). Provide an `auditor` function to require an independent verdict
before a completion is archived; a rejection pauses the goal.

## Agent tools

The same workflow is exposed as model tools: `goal_status`, `goal_set`,
`goal_pause`, `goal_resume`, `goal_block`, `goal_complete`. They return compact
JSON envelopes.

## Persistence

State is written owner-only (`0600`) under `.opencode/goals/state.json` (or
`stateFilePath` / `OPENCODE_GOAL_STATE_PATH`). V2 uses plugin storage instead.
Recovered active goals load **paused** so unattended runs do not resume blindly.
Add `.opencode/goals/` to your `.gitignore`.

## Plan-mode safety

A goal created while a restricted agent (`plan` by default) is active is
recorded but held, and auto-continue stays suppressed. Run `/goal resume` from
an executing agent to start.

## Local testing

**Automated suite** (no model/network needed):

```sh
npm install
npm test          # 56 tests: core, V1 hooks, V2 mock, multi-turn loop
npm run typecheck
npm run build
node dist/verify.js
```

**Against a real OpenCode** — this repo ships a loader at
`.opencode/plugins/opencode-goal-loop.ts` that re-exports the built plugin, so
you can dogfood it directly:

```sh
npm run build
opencode          # run from the repo root
```

Then in the TUI:

```
/goal fix the failing tests and verify the suite passes --max-turns 3
```

Watch it auto-continue on idle and finish with `[goal:evidence]` /
`[goal:complete]`. State is written to `.opencode/goals/state.json`.

To use the plugin in *another* project before it is published, build it and
either

1. Copy `.opencode/plugins/opencode-goal-loop.ts` into that project's
   `.opencode/plugins/` (adjust the relative import), or
2. Point that project's config at the built entry:

   ```json
   { "plugin": ["/absolute/path/to/opencode-goal-loop/dist/index.js"] }
   ```

### Use it everywhere (global)

Create a loader in the global plugin directory that re-exports the built entry:

```sh
mkdir -p ~/.config/opencode/plugins
cat > ~/.config/opencode/plugins/opencode-goal-loop.ts <<'EOF'
export { default } from "/absolute/path/to/opencode-goal-loop/dist/index.js"
EOF
```

Restart OpenCode (the background service caches plugins) and `/goal` is
available in every project. The plugin initializes exactly once even if it is
loaded from both the global directory and a project's `.opencode/plugins/`.

(OpenCode 1.18.29+ / 2.x call one or both of `server` and `setup` for a package
that exposes both; the plugin claims activation once — V1 via `server`, V2 via
`setup`.)

## Releasing

Releases are automated with GitHub Actions.

- **`ci.yml`** runs `typecheck`, `test`, `build`, and `pack:check` on every push
  to `main` and every pull request, across Node 22, 24, and 26.
- **`release.yml`** runs [release-please](https://github.com/googleapis/release-please).
  It reads [Conventional Commits](https://www.conventionalcommits.org) and opens
  a "release PR" that bumps the version and updates `CHANGELOG.md`. Merging that
  PR creates the git tag and GitHub Release, and the same workflow then publishes
  to npm with OIDC **trusted publishing** — no tokens stored, provenance attached.

So a release is just: merge a `feat:`/`fix:` PR, then merge the release PR that
release-please opens. For a one-off manual release, use `npm version <patch|minor|major>`
and push the tag (the trusted publisher must allow direct `npm publish`).

### One-time npm setup

Add a Trusted Publisher for the package on npmjs.com
(**Package → Settings → Trusted publishing**) with:

| Field | Value |
|---|---|
| Organization or user | `omerdduran` |
| Repository | `opencode-goal-loop` |
| Workflow filename | `release.yml` |
| Allowed actions | enable **`npm publish`** (Allow npm publish) |

The workflow filename must match exactly (case-sensitive, `.yml` included) and
the first publish must succeed within 2 days, otherwise the configuration expires.

### Development requirements

The published package is plain JavaScript, but the test suite imports the
TypeScript sources directly, so running this repo's tests requires **Node 22.18+**
(type stripping on by default).

## Limitations

- Completion/block markers are model-dependent unless an `auditor` is
  configured. The evidence gate is always enforced.
- V1 command interception works by mutating the retained command-turn parts;
  the model still produces the visible response.
- Experimental V1 hooks may change between OpenCode versions.

## License

MIT
