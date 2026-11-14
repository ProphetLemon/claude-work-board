# Board stale agents

## Objective

The swarm box shows a subagent as running only while it runs. A finished agent never stays "running", and a resumed agent keeps one row.

## Problem

- A user's board showed 4 finished subagents as running with `0 tools · starting…` for 2 hours, and T7 twice. ListAgents in that session listed all of them as completed.
- `sync()` (`hooks/register.tsx`, `if (!info) return row`) closes an open row only when `$.agent.list()` still lists the agent with an ended status. The engine drops a finished subagent's entry some time after it ends (`$.agent.list` doc: "until the engine drops its task ... a subagent's later"). Any end the board does not witness (the mod not loaded, a reload between the end and the drop) leaves the row open forever. The rows live in `$.state`, which outlives reloads.
- `agent.spawn` also fires when a message resumes an ended agent (`e.resume.agentId`). `recordSpawn` ignores `resume` and appends a second row for the same agent.
- A workflow script's agents raise `agent.spawn` (`e.workflow` set) but are never in `$.agent.list()` ("a workflow's are not"), so their rows never close either.

## Why

The board exists to show what is running. Rows that never close make it say work is happening when nothing is, and the person cannot trust it before closing the session.

## Scope

- `hooks/register.tsx`, `types/index.d.ts`, `tests/board.test.tsx`, `README.md`.
- New `AgentRow` fields stay optional, and the `agents-1` shape is not bumped, so rows stored by the current version still load (and get closed).
- Not in scope: why the observed rows showed `0 tools` (unverified: seeded by sync, an unbound id, or hooks not loaded during the run). The reconciliation below closes such rows whatever created them.

## Design

- A subagent's own `turn.complete` (`e.agentId` set) closes the open row with that id: `killed` when `isAborted`, `failed` when `reason === 'error'`, otherwise `completed`. Same log line and background alert as when `sync` sees the end.
- In `sync`, an open row that is not a workflow row, has no match in a list that resolved (not the `catch` path), and started more than a grace period ago (30s) is closed as `completed` with a `gone: <description>` log line and no toast: its end was missed, possibly long ago.
- A spawn with `resume` reopens the row whose `id` is `resume.agentId` (status `running`, `endedAt` cleared, `startedAt` now, `toolUseId` the new call's) and logs `resumed: …`. With no such row, it appends one under that id.
- Workflow rows (`workflow: true`) are exempt from the orphan rule and close through `turn.complete` only.

## Checks

- TDD: off (no project configuration; same source as `board-extra-info`). Ordinary checks run on every task.
- `npx -p typescript@5.6 tsc -p . --noEmit`
- `claude plugin validate .` (expected: passes with the ICON_MISSING warning)
- `claude plugin test .`
- RDD: off (global), so no native review.

## Tasks

Route: delegated direct, one writer. Trigger: 2 non-trivial files (`hooks/register.tsx`, `tests/board.test.tsx`), and the long-session backstop.

- [x] T1 fix: close rows whose end the board missed (subagent `turn.complete`, the orphan rule in `sync`, workflow rows exempt), with tests
- [x] T2 fix: a resumed agent reopens its row instead of adding one, with tests
- [x] T3 docs: the README's Swarm line says how a missed end is shown (`gone`) and that a resumed agent keeps its row

## Acceptance criteria

- A stored open row whose agent is absent from a resolved list, older than the grace period, is closed on the next sync.
- A rejected `$.agent.list()` closes nothing.
- An open row younger than the grace period, or a workflow row, stays open while absent from the list.
- A subagent's `turn.complete` closes its row with the right status.
- Spawn, end, then a spawn with `resume` for the same agent: one row, open, and its tool calls count on it.

## Delivery

- Forecast: about 200–300 authored changed lines, under the 400 budget. Strategy: `ask-on-risk`, a single PR if the person wants one.
- Branch `fix/board-stale-agents`, from `main` at `c7c5353`.

## Progress

- T1 done. Evidence: tests `a row whose end was missed closes once the grace has passed`, `a list that fails to resolve closes nothing`, `a listed agent stays open however long it runs`, `a workflow row is never judged missing and closes on its own turn.complete`, `a subagent turn.complete closes its row as completed, killed or failed`, `a subagent turn.complete leaves the lead busy state alone`; tsc, plugin validate (ICON_MISSING warning only) and plugin test (13 pass) all passed. Commit: 89d24e4.
- T2 done. Evidence: tests `a resumed agent keeps its one row and its tool calls count on it`, `a resume for an agent the board never saw adds a row under its id`; tsc, plugin validate (ICON_MISSING warning only) and plugin test (15 pass) all passed.
- T2 commit: ca91c90.
- T3 done. README Swarm line updated; tsc, plugin validate and plugin test (15 pass) passed.

## Next step

None: ready for the person to push or open a PR.
