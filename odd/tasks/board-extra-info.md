# Board extra info

## Objective

Show more useful information on the work board without taking rows from the session log.

## Problem

- Rate limits show the percentage used but not when they reset, although `resetsAt` is already stored.
- Files the lead changed show up only in the log, which scrolls away.
- Only a running turn's time is shown. The last turn's time and the last advisor call's time are lost.
- Bug: `tool.call` hands the tool's arguments flat on `e` (`e.file_path`), but the hook reads `e.input`. Every hint is empty, so the log and the subagent `↳` line show a bare tool name.

## Scope

- `hooks/register.tsx`, `types/index.d.ts`, `README.md`, a new `tests/board.test.tsx`.
- New `MainRow` fields stay optional, and the `main-2` shape is not bumped, so live counters survive a reload.
- No new boxes. New information goes into existing lines, plus one conditional row in the LEAD box that counts toward `leadRows`.

## Checks

- TDD: off (no project configuration). Ordinary checks run on every task.
- `npx -p typescript@5.6 tsc -p . --noEmit` (baseline on HEAD: passes)
- `claude plugin validate .` (baseline: passes with the ICON_MISSING warning)
- `claude plugin test .`
- RDD: off (global), so no native review.

## Tasks

Route for every task: direct inline. Only one file is non-trivial (`register.tsx`). It was read in full, and the design is settled.

- [x] T1 fix: read the tool's arguments from `e`, so hints and file names show
  - Evidence: `tests/board.test.tsx` fails without the fix (`Expected: defined, Received: undefined`) and passes with it. tsc passes; it needed a double cast on `$.tool.call` in the test, because the Edit-typed overload hits TS2589. Commit `6c41f7b`.
- [x] T2 feat: limit reset time on the limits line (`↻HH:MM` under 24h, `↻Nd Hh` beyond)
  - Evidence: test `each rate limit shows when it resets` passes (under 24h, beyond 24h, missing, past). tsc passes. Commit `103f58e`.
- [x] T3 feat: files the lead changed (Edit/Write/NotebookEdit, not denied or errored, deduplicated, basenames, capped), on one conditional LEAD row
  - Evidence: tests `the lead row lists the files...` (deduplication, order, deny, isError, a subagent, Read) and `no files row...` pass. tsc passes. A `main` without `files` (the state before this change) renders: it is the initial value in every test. Commit `81253e6`.
- [x] T4 feat: last turn time in the idle text, last advisor call's duration (only when `endedAt > startedAt`)
  - The turn time comes from the engine (`turn.complete`'s `durationMs`), not from the clock.
  - Evidence: tests `the idle lead shows how long the last turn took` and `the advisor shows how long its last call took...` (timed, and a response that came whole) pass. tsc and validate pass. Commit `b53ebe0`.
- [x] T5 fix (from the closing review): with the reset times, the limits line went from ~37 to ~50 characters and was cut off in panes of ~41–53 columns. It now falls back to short names (`5h`, `7d`) and then drops the resets.
  - Evidence: test `a narrow pane gets a shorter limits line...` (40 and 30 columns) passes. tsc and validate pass.
- [x] T6 docs: the README states the files row's limits (only Edit/Write/NotebookEdit; shell edits are not seen) and the narrow form of the limits line.

## Progress

Branch `feat/board-extra-info`, from `main` at `bce0f05`. All 6 tasks done: 7 tests pass, tsc passes, validate passes with the ICON_MISSING warning. Nobody has seen the pane drawn live; only the test kit's mounts.

## Next step

The person decides on push, PR or merge. Install the mod again (or reload it) to see the changes in the pane.
