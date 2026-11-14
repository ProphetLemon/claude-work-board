# work-board

A Claude Code mod that keeps a live board beside the chat, so you can watch the session work:

- **Lead**: the main session's model, effort, tool calls and steps, how long the current turn has been running and, once it ends, how long it took. Also the context window fill, the cost, and each rate limit with when it resets (the clock time within a day, days and hours beyond). It also lists the files the lead changed with Edit, Write or NotebookEdit, newest first. Denied or failed calls, subagents' edits and edits made from the shell (`sed`, `sd`, redirects) are not seen. On a narrow pane the limits line uses short names (`5h`, `7d`) and, if needed, drops the reset times.
- **Advisor**: how many times the advisor was consulted, when it was last consulted and how long that call took, and a timeline of the calls.
- **Swarm**: every subagent with its model, its tool calls, its elapsed time and whether it is running, done or failed. A subagent that finished while the board was not watching is shown as ended, with a `gone` line in the log. A resumed subagent keeps its row.
- **Session log**: the latest events with their time.

The board animates while something is happening (spinners, pulses along the connector lines, a breathing border on the active box, a typed-in log line). When nothing is happening it refreshes once a second. Subagents report no progress, so their bars show activity, not a percentage.

The pane opens by itself in a wide terminal. Run `/board` to open it at any width.

## Install

At the prompt of a terminal session:

```
/plugin install work-board --marketplace ProphetLemon/claude-work-board
```

Answer `y` to add the marketplace, then pick a scope (the user scope comes first; press Enter).

From a shell:

```
claude plugin install work-board --marketplace ProphetLemon/claude-work-board
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ProphetLemon/claude-work-board`, then Add plugin.

This repository is private. It installs only for people who can read it on GitHub and whose machine already holds a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`). The install never prompts for one.
