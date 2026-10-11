# Changelog

## [0.1.1](https://github.com/omerdduran/opencode-goal-loop/compare/v0.1.0...v0.1.1) (2026-10-11)


### Bug Fixes

* correct the Node requirement for running the test suite ([874641d](https://github.com/omerdduran/opencode-goal-loop/commit/874641d128076dba74ee421ae27a89d93f524c41))

## 0.1.0

Initial release.

- Dual support: one package exports `{ id, server, setup }` for OpenCode V1
  (1.18.29+) and V2.
- Session-scoped goals with `/goal`, plus `add`, `list`, `focus`, `status`,
  `history`, `pause`, `resume`, `edit`, `sequence`, and `clear`.
- Guarded auto-continuation on `session.idle` with a durable claim guard,
  cooldown, and human-intervention detection.
- Evidence-gated completion and blocker handling (`[goal:evidence]` /
  `[goal:complete]` / `[goal:blocked]`).
- Safety limits: turns, duration, tokens, cost, no-progress, no-tool-call, and a
  budget wrap-up prompt.
- Compaction survival: goal summary injected into the compaction context;
  OpenCode's generic post-compaction auto-continue suppressed while a goal is
  active. On V2 the active goal is injected into every agent-loop request.
- Persistence (V1 file-based, V2 plugin storage) with recovery-paused loading.
- Plan-mode safety: goals are held while a restricted agent is active.
- Agent-facing tools and a self-check binary.

  Verified against OpenCode 1.18.35 and 2.0.26: the plugin loads in both
  runtimes, `server`/`setup` return cleanly, the goal command is registered, and
  all six goal tools are present.
