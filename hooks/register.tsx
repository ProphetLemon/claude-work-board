import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { AgentRow, LogRow, MainRow, UsageRow } from '../types'

const PANE = 'work-board'
const TITLE = 'Work board'
const SYNC_MS = 3000
const USAGE_MS = 5000
// One animation frame. The pane is redrawn at this rate only while something
// moves (a turn, a running subagent, a fresh event); otherwise once a second.
const FRAME_MS = 140
const IDLE_MS = 1000
const RECENT_MS = 4000
const TYPE_MS_PER_CHAR = 22
const LOG_KEEP = 200
const AGENT_KEEP = 40
const TIMES_KEEP = 24

// Role colours, as in a terminal dashboard: orange lead, purple advisor,
// blue swarm, green for finished work. Each has a bright twin for the glow.
const LEAD = '#e8916b'
const LEAD_HI = '#ffc29e'
const ADVISOR = '#c3a6ff'
const ADVISOR_HI = '#eee4ff'
const SWARM = '#8fb3ff'
const SWARM_HI = '#d2e2ff'
const DONE = '#9ece6a'
const FAIL = '#f7768e'
const WARN = '#e0af68'
const LINE = '#565f89'
const BRIGHT = '#ffffff'

// Bump a shape tag when that value's fields change: it declines what an
// earlier version stored, which outlives a reload.
const agents = atom({ plugin: 'work-board', key: 'agents' } as const, [] as AgentRow[], {
  shape: 'agents-1',
})
const log = atom({ plugin: 'work-board', key: 'log' } as const, [] as LogRow[], {
  shape: 'log-1',
})
const main = atom(
  { plugin: 'work-board', key: 'main' } as const,
  {
    model: '',
    effort: '',
    toolCalls: 0,
    steps: 0,
    advisorCalls: 0,
    advisorTimes: [],
    busy: false,
    startedAt: 0,
  } as MainRow,
  { shape: 'main-2' },
)

const usage = atom(
  { plugin: 'work-board', key: 'usage' } as const,
  { window: 0, percent: 0, limits: [] } as UsageRow,
  { shape: 'usage-1' },
)

// Animation pacing only; losing these on a reload costs one idle second.
let animateUntil = 0
let lastPaint = 0
let mainBusy = false
let openAgents = 0

const TERMINAL = new Set(['completed', 'failed', 'killed', 'idle'])
const isOpen = (status: string) => !TERMINAL.has(status)

const ASCII_SPIN = ['|', '/', '-', '\\']
const DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const spin = (f: number) => ASCII_SPIN[f % ASCII_SPIN.length] ?? '|'
const dots = (f: number) => DOTS[f % DOTS.length] ?? '•'

const pad = (n: number) => String(n).padStart(2, '0')

function clockText(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function elapsedText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${pad(s % 60)}s`
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`
}

function shortModel(model: string): string {
  const m = model.toLowerCase()
  for (const name of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(name)) return name
  return model || '?'
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, Math.max(1, max - 1))}…` : one
}

// An indeterminate bar: a three-cell block sweeping back and forth. Subagents
// report no progress, so the board shows motion, not a made-up percentage.
function scanner(f: number, width: number): string {
  const span = 3
  const travel = Math.max(1, width - span)
  const step = f % (travel * 2)
  const pos = step <= travel ? step : travel * 2 - step
  let out = ''
  for (let i = 0; i < width; i += 1) out += i >= pos && i < pos + span ? '▰' : '▱'
  return out
}

// A line with a dot travelling along it: [before, dot, after].
function pulse(f: number, width: number): [string, string, string] {
  const w = Math.max(3, width)
  const pos = f % w
  return ['─'.repeat(pos), '●', '─'.repeat(w - pos - 1)]
}

// The advisor's calls over the session, as ticks on a strip.
function timeline(times: readonly number[], start: number, t: number, width: number): string {
  const cells = Array.from({ length: width }, () => '·')
  const span = Math.max(1, t - start)
  for (const at of times) {
    const i = Math.min(width - 1, Math.max(0, Math.floor(((at - start) / span) * (width - 1))))
    cells[i] = '▌'
  }
  return cells.join('')
}

function typed(text: string, at: number, t: number): { shown: string; isTyping: boolean } {
  const count = Math.floor((t - at) / TYPE_MS_PER_CHAR)
  return count >= text.length
    ? { shown: text, isTyping: false }
    : { shown: text.slice(0, Math.max(0, count)), isTyping: true }
}

// A short hint of what a tool call is about: a Bash description, a file's
// base name, a search pattern. Reads only string fields, so any tool works.
function toolHint(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const fields = input as Record<string, unknown>
  for (const key of ['description', 'file_path', 'pattern', 'query', 'url', 'command']) {
    const value = fields[key]
    if (typeof value === 'string' && value) {
      return key === 'file_path' ? (value.split('/').pop() ?? value) : value
    }
  }
  return ''
}

// The tool calls not worth a log line: reads and searches are counted, not
// listed, so the log keeps what changed.
const QUIET = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'Agent', 'Task'])

function describeTool(tool: string, input: unknown): string {
  const hint = toolHint(input)
  return hint ? `${tool}: ${clip(hint, 56)}` : tool
}

function tokensText(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  return `${Math.round(n / 1000)}k`
}

function meter(percent: number, width: number): string {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)))
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

const limitName = (kind: string) => clip(kind.replace(/[_-]+/g, ' '), 12)

// When a limit window resets: the clock time within a day, days and hours
// beyond, so a weekly window does not read as today. Nothing for a time
// that is missing, unreadable or already past.
function resetText(resetsAt: string | undefined, t: number): string {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN
  if (!Number.isFinite(at) || at <= t) return ''
  if (at - t < 86_400_000) {
    const d = new Date(at)
    return ` ↻${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const hours = Math.floor((at - t) / 3_600_000)
  return ` ↻${Math.floor(hours / 24)}d${hours % 24}h`
}

// Context fill, cost and rate limits, as the status line has them. Written
// only when they change, so a quiet session redraws nothing for them.
async function pollUsage($: EngineInterface) {
  const now = await $.session.usage()
  const window = now.context.window
  const percent =
    now.context.percent ?? (now.context.tokens !== undefined && window > 0 ? (now.context.tokens / window) * 100 : 0)
  const row: UsageRow = {
    tokens: now.context.tokens,
    window,
    percent,
    usd: now.cost?.usd,
    limits: now.rateLimits.map(one => ({ kind: one.kind, percentUsed: one.percentUsed, resetsAt: one.resetsAt })),
  }
  const before = await read($, usage)
  if (JSON.stringify(before) !== JSON.stringify(row)) await update($, usage, () => row)
}

function wake(at: number) {
  animateUntil = Math.max(animateUntil, at + RECENT_MS)
}

async function paint($: EngineInterface) {
  const t = await $.clock.now()
  const moving = mainBusy || openAgents > 0 || t < animateUntil
  if (moving || t - lastPaint >= IDLE_MS) {
    lastPaint = t
    $.ui.invalidate('ui.render')
  }
}

async function addLog($: EngineInterface, who: LogRow['who'], text: string) {
  const at = await $.clock.now()
  wake(at)
  await update($, log, list => [...list, { at, who, text }].slice(-LOG_KEEP))
}

// Matches each open row against the engine's agent list: by id first, then
// by description for a row whose spawn did not report an id yet.
async function sync($: EngineInterface) {
  const at = await $.clock.now()
  let infos: AgentInfo[] = []
  try {
    infos = await $.agent.list()
  } catch {
    infos = []
  }
  const ended: string[] = []
  const alerts: string[] = []
  const seeded: AgentRow[] = []
  let changed = false
  const current = await read($, agents)
  const known = new Set(current.map(row => row.id))
  const next = current.map(row => {
    if (!isOpen(row.status)) return row
    const info =
      infos.find(one => one.id === row.id) ??
      infos.find(one => !known.has(one.id) && one.description === row.description)
    if (!info) return row
    known.add(info.id)
    if (info.status === row.status && info.id === row.id) return row
    changed = true
    if (!isOpen(info.status)) {
      const verb = info.status === 'failed' || info.status === 'killed' ? info.status : 'done'
      ended.push(`${verb}: ${clip(row.description, 48)}`)
      if (row.background) alerts.push(`${verb === 'done' ? 'Done' : verb === 'failed' ? 'Failed' : 'Stopped'}: ${clip(row.description, 80)}`)
    }
    return { ...row, id: info.id, status: info.status, endedAt: isOpen(info.status) ? undefined : at }
  })
  for (const info of infos) {
    if (known.has(info.id) || !isOpen(info.status)) continue
    changed = true
    seeded.push({
      id: info.id,
      toolUseId: info.id,
      description: info.description,
      type: info.type,
      model: '',
      status: info.status,
      startedAt: at,
      tools: 0,
      background: true,
    })
  }
  if (changed) await update($, agents, () => [...next, ...seeded].slice(-AGENT_KEEP))
  openAgents = [...next, ...seeded].filter(row => isOpen(row.status)).length
  for (const text of ended) await addLog($, 'swarm', text)
  for (const text of alerts) {
    $.ui.toast(text, { timeoutMs: 6000 })
    await $.ui.notify(text, { title: 'Subagent finished' }).catch(() => undefined)
  }
  for (const row of seeded) await addLog($, 'swarm', `found running: ${clip(row.description, 48)}`)
}

type SpawnInput = {
  tool_use_id: string
  description: string
  subagentType: string
  model?: string
  parentModel: string
  fork: boolean
  background: boolean
}
type ServerUse = { startedAt: number; endedAt?: number }

async function recordSpawn($: EngineInterface, e: SpawnInput) {
  const at = await $.clock.now()
  const row: AgentRow = {
    id: e.tool_use_id,
    toolUseId: e.tool_use_id,
    description: e.description,
    type: e.subagentType || (e.fork ? 'fork' : 'agent'),
    model: e.model ?? e.parentModel,
    status: 'running',
    startedAt: at,
    tools: 0,
    background: e.background,
  }
  openAgents += 1
  await update($, agents, list => [...list, row].slice(-AGENT_KEEP))
  await addLog($, 'swarm', `spawned ${shortModel(row.model)}: ${clip(e.description, 48)}`)
}

async function recordSpawned(
  $: EngineInterface,
  toolUseId: string,
  spawned: { model?: string; agentId?: string; deny?: string },
) {
  const at = await $.clock.now()
  await update($, agents, list =>
    list.map(one => {
      if (one.toolUseId !== toolUseId) return one
      if (spawned.deny !== undefined) return { ...one, status: 'failed', endedAt: at }
      return { ...one, id: spawned.agentId ?? one.id, model: spawned.model || one.model }
    }),
  )
  if (spawned.deny !== undefined) await addLog($, 'swarm', `refused: ${clip(spawned.deny, 48)}`)
}

async function recordToolCall($: EngineInterface, agentId: string | undefined, tool: string, input: unknown) {
  const at = await $.clock.now()
  if (agentId) {
    await update($, agents, list =>
      list.map(one =>
        one.id === agentId
          ? { ...one, tools: one.tools + 1, lastToolAt: at, lastTool: describeTool(tool, input) }
          : one,
      ),
    )
    return
  }
  await update($, main, row => ({ ...row, toolCalls: row.toolCalls + 1 }))
  if (QUIET.has(tool)) return
  await addLog($, 'lead', describeTool(tool, input))
}

async function recordStep(
  $: EngineInterface,
  model: string,
  effort: string | number | undefined,
  advisorUses: readonly ServerUse[],
) {
  const times = advisorUses.map(use => use.endedAt ?? use.startedAt)
  const last = times.at(-1)
  await update($, main, row => ({
    ...row,
    model: model || row.model,
    effort: effort === undefined ? row.effort : String(effort),
    steps: row.steps + 1,
    advisorCalls: row.advisorCalls + advisorUses.length,
    advisorTimes: [...(row.advisorTimes ?? []), ...times].slice(-TIMES_KEEP),
    lastAdvisorAt: last ?? row.lastAdvisorAt,
  }))
  for (let i = 0; i < advisorUses.length; i += 1) await addLog($, 'advisor', 'consulted')
}

async function markBusy($: EngineInterface, busy: boolean) {
  const at = await $.clock.now()
  mainBusy = busy
  wake(at)
  await update($, main, row => ({ ...row, busy, turnStartedAt: busy ? at : row.turnStartedAt }))
}

async function start($: EngineInterface) {
  const at = await $.clock.now()
  const model = await $.session.model().catch(() => '')
  await update($, main, row => ({
    ...row,
    model: model || row.model,
    advisorTimes: row.advisorTimes ?? [],
    startedAt: row.startedAt || at,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'board',
      description: 'Open the work board: main session, advisor, subagents and log',
    })
    await start($).catch(() => undefined)
    $.clock.every(FRAME_MS, () => {
      void paint($)
    })
    $.clock.every(SYNC_MS, () => {
      void sync($)
    })
    $.clock.every(USAGE_MS, () => {
      void pollUsage($).catch(() => undefined)
    })
    void pollUsage($).catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE })
    void sync($)

    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Work board opened.' }
  })

  // The board's bookkeeping never gates the work: each write is caught, so a
  // failed update leaves the turn, spawn or tool call exactly as it was.
  on('turn.start', async ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) await markBusy($, true).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!(e as { agentId?: string }).agentId) await markBusy($, false).catch(() => undefined)

    return done
  })

  on('agent.spawn', async ($, e, next) => {
    await recordSpawn($, e).catch(() => undefined)
    const spawned = await next(e)
    await recordSpawned($, e.tool_use_id, spawned).catch(() => undefined)

    return spawned
  })

  // The tool's arguments sit on `e` itself, beside `tool` (`e.command` for
  // Bash), so the hint is read from `e`.
  on('tool.call', async ($, e, next) => {
    await recordToolCall($, e.agentId, e.tool, e).catch(() => undefined)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId) {
      const advisorUses = (result.serverToolUses ?? []).filter(use => use.name === 'advisor')
      await recordStep($, e.model, e.effort, advisorUses).catch(() => undefined)
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const t = await $.clock.now()
    const f = Math.floor(t / FRAME_MS)
    const rows = e.viewport?.rows ?? 40
    const inner = Math.max(24, (e.props.bodyColumns || 60) - 4)
    const lead = await read($, main)
    const swarm = await read($, agents)
    const lines = await read($, log)
    const spend = await read($, usage)
    const breathe = f % 8 < 4

    // Lead: the border breathes while a turn runs.
    const busy = lead.busy
    const leadBorder = busy && breathe ? LEAD_HI : LEAD
    const working = busy && lead.turnStartedAt ? `working ${elapsedText(t - lead.turnStartedAt)}` : 'idle · your turn'

    // Advisor: flashes for a few seconds after a consultation.
    const advising = lead.lastAdvisorAt !== undefined && t - lead.lastAdvisorAt < RECENT_MS
    const advisorBorder = advising && f % 2 === 0 ? ADVISOR_HI : ADVISOR
    const onCallDot = f % 14 < 7 ? '●' : '○'
    const strip = timeline(lead.advisorTimes ?? [], lead.startedAt || t, t, Math.max(8, inner - 14))

    // Swarm: running first, then the latest finished, as many as fit.
    const open = swarm.filter(one => isOpen(one.status))
    const closed = swarm.filter(one => !isOpen(one.status))
    // A running subagent takes three rows (name, bar, last action), a
    // finished one two; the log gets what is left, at least three lines.
    const hasContext = spend.window > 0
    const hasLimits = spend.limits.length > 0
    const leadRows = 5 + (hasContext ? 1 : 0) + (hasLimits ? 1 : 0)
    const fixed = leadRows + 5 + 1 + 3 + 1 + 3 + 1
    let room = Math.max(3, rows - fixed - 3)
    const shownOpen: AgentRow[] = []
    for (const one of open) {
      if (room < 3 && shownOpen.length > 0) break
      shownOpen.push(one)
      room -= 3
    }
    const shownClosed: AgentRow[] = []
    for (const one of [...closed].reverse()) {
      if (room < 2) break
      shownClosed.unshift(one)
      room -= 2
    }
    const shown = [...shownOpen, ...shownClosed]
    const agentLines = shownOpen.length * 3 + shownClosed.length * 2
    const logRoom = Math.max(3, rows - fixed - Math.max(1, agentLines))
    const contextTone = spend.percent >= 85 ? (breathe ? FAIL : WARN) : spend.percent >= 70 ? WARN : LEAD
    const limitTone = spend.limits.some(one => one.percentUsed >= 80) ? WARN : LINE
    const spawning = swarm.some(one => t - one.startedAt < RECENT_MS)
    const returning = closed.some(one => one.endedAt !== undefined && t - one.endedAt < RECENT_MS)
    const swarmBorder = open.length > 0 && (spawning ? f % 2 === 0 : breathe) ? SWARM_HI : SWARM
    const lineWidth = Math.max(6, inner - 22)
    const [down0, downDot, down1] = pulse(f, lineWidth)
    const [up0, upDot, up1] = pulse(f, lineWidth)

    const agentRow = (one: AgentRow) => {
      const running = isOpen(one.status)
      const failed = one.status === 'failed' || one.status === 'killed'
      const fresh = t - (one.endedAt ?? one.startedAt) < RECENT_MS
      const busyNow = running && one.lastToolAt !== undefined && t - one.lastToolAt < 1500
      const mark = running ? dots(f) : failed ? '✗' : '✓'
      const tone = running ? (busyNow && f % 2 === 0 ? SWARM_HI : SWARM) : failed ? FAIL : DONE
      const barWidth = Math.min(12, Math.max(6, inner - 34))
      const bar = running ? scanner(f, barWidth) : '▰'.repeat(barWidth)
      const time = elapsedText((one.endedAt ?? t) - one.startedAt)
      const extra = running && one.status !== 'running' ? ` · ${one.status}` : ''
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text color={tone} bold={running}>{mark} </Text>
            <Text wrap="truncate" color={fresh ? BRIGHT : undefined} bold={fresh} dimColor={!running && !fresh}>
              {clip(one.description, inner - 2)}
            </Text>
          </Box>
          <Box flexDirection="row">
            <Text color={tone}>{`  ${bar}`}</Text>
            <Text wrap="truncate" color={LINE}>
              {` ${shortModel(one.model)} · ${one.tools} tools · ${time}${extra}`}
            </Text>
          </Box>
          {running && (
            <Text wrap="truncate" color={busyNow ? SWARM_HI : LINE}>
              {`  ↳ ${clip(one.lastTool ?? 'starting…', inner - 4)}`}
            </Text>
          )}
        </Box>
      )
    }

    const tone = (who: LogRow['who']) => (who === 'lead' ? LEAD : who === 'advisor' ? ADVISOR : SWARM)
    const recent = lines.slice(-logRoom)
    const newest = recent.at(-1)
    const live = mainBusy || openAgents > 0 || t < animateUntil
    const footerText = newest ? `${newest.who} ${newest.text}` : 'waiting for work'
    const footer = newest ? typed(footerText, newest.at, t) : { shown: footerText, isTyping: false }
    const cursor = footer.isTyping || breathe ? '▌' : ' '
    const squares = swarm
      .slice(-8)
      .map(one => (isOpen(one.status) ? 'run' : one.status === 'completed' || one.status === 'idle' ? 'ok' : 'bad'))

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor={leadBorder} borderDimColor={!busy} paddingX={1}>
          <Text>
            <Text color={busy ? LEAD_HI : LEAD} bold>LEAD · main session</Text>
            <Text color={LINE}>{` [ ${busy ? spin(f) : ' '} ]`}</Text>
          </Text>
          <Text wrap="truncate">
            {`${shortModel(lead.model)}${lead.effort ? ` · effort ${lead.effort}` : ''} · ${working}`}
          </Text>
          <Text wrap="truncate" color={LINE}>
            {`${lead.toolCalls} tool calls · ${lead.steps} steps${lead.startedAt ? ` · up ${elapsedText(t - lead.startedAt)}` : ''}`}
          </Text>
          {hasContext && (
            <Text wrap="truncate">
              <Text color={LINE}>{'context '}</Text>
              <Text color={contextTone}>{meter(spend.percent, Math.min(12, Math.max(6, inner - 34)))}</Text>
              <Text color={contextTone} bold={spend.percent >= 85}>{` ${Math.round(spend.percent)}%`}</Text>
              <Text color={LINE}>
                {`${spend.tokens !== undefined ? ` · ${tokensText(spend.tokens)}/${tokensText(spend.window)}` : ''}${spend.usd !== undefined ? ` · $${spend.usd.toFixed(2)}` : ''}`}
              </Text>
            </Text>
          )}
          {hasLimits && (
            <Text wrap="truncate" color={limitTone}>
              {`limits  ${spend.limits.map(one => `${limitName(one.kind)} ${Math.round(one.percentUsed)}%${resetText(one.resetsAt, t)}`).join(' · ')}`}
            </Text>
          )}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor={advisorBorder} borderDimColor={!advising} paddingX={1}>
          <Text>
            <Text color={advising ? ADVISOR_HI : ADVISOR} bold>ADVISOR</Text>
            <Text color={advising ? ADVISOR_HI : LINE}>
              {advising ? ` · advising [ ${spin(f)} ]` : ` · on call ${onCallDot}`}
            </Text>
          </Text>
          <Text wrap="truncate">
            {`${lead.advisorCalls} calls${lead.lastAdvisorAt ? ` · last ${clockText(lead.lastAdvisorAt)}` : ''}`}
          </Text>
          {advising ? (
            <Text wrap="truncate">
              <Text color={LINE}>{'→ lead '}</Text>
              <Text color={LINE}>{down0}</Text>
              <Text color={ADVISOR_HI}>{downDot}</Text>
              <Text color={LINE}>{down1}</Text>
            </Text>
          ) : (
            <Text wrap="truncate">
              <Text color={LINE}>{'calls  '}</Text>
              <Text color={ADVISOR}>{strip}</Text>
            </Text>
          )}
        </Box>
        <Text wrap="truncate">
          <Text color={LINE}>{'  delegate '}</Text>
          {open.length > 0 ? (
            <Text>
              <Text color={LINE}>{down0}</Text>
              <Text color={SWARM_HI}>{downDot}</Text>
              <Text color={LINE}>{down1}</Text>
            </Text>
          ) : (
            <Text color={LINE}>{'┄'.repeat(lineWidth)}</Text>
          )}
          <Text color={open.length > 0 ? SWARM : LINE}>{` ${open.length} running`}</Text>
        </Text>
        <Box flexDirection="column" borderStyle="round" borderColor={swarmBorder} borderDimColor={open.length === 0} paddingX={1}>
          <Text>
            <Text color={open.length > 0 ? SWARM_HI : SWARM} bold>SWARM · subagents</Text>
            <Text color={LINE}>{` [ ${open.length > 0 ? spin(f) : ' '} ] ${open.length} running · ${closed.length} done`}</Text>
          </Text>
          {shown.length === 0 && <Text dimColor>No subagents yet.</Text>}
          {shown.map(agentRow)}
        </Box>
        <Text wrap="truncate">
          <Text color={LINE}>{'  back to lead '}</Text>
          {returning ? (
            <Text>
              <Text color={LINE}>{up1}</Text>
              <Text color={DONE}>{upDot}</Text>
              <Text color={LINE}>{up0}</Text>
            </Text>
          ) : (
            <Text color={LINE}>{'┄'.repeat(lineWidth)}</Text>
          )}
        </Text>
        <Box flexDirection="column" borderStyle="round" borderColor={LINE} paddingX={1}>
          <Text>
            <Text color={BRIGHT} bold>SESSION LOG</Text>
            <Text color={LINE}>{` [ ${live ? `live · ${spin(f)}` : 'quiet'} ]`}</Text>
          </Text>
          {recent.length === 0 && <Text dimColor>Nothing yet.</Text>}
          {recent.map(one => {
            const isNewest = one === newest
            const fresh = t - one.at < 2500
            const text = isNewest ? typed(one.text, one.at, t) : { shown: one.text, isTyping: false }
            return (
              <Box flexDirection="row">
                <Text color={LINE}>{`${clockText(one.at)} `}</Text>
                <Text color={tone(one.who)} bold={fresh}>{`${one.who.padEnd(7)} `}</Text>
                <Text wrap="truncate" color={fresh ? BRIGHT : undefined}>
                  {`${text.shown}${text.isTyping ? '▌' : ''}`}
                </Text>
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="row">
          <Text color={LINE}>{'# '}</Text>
          <Text wrap="truncate" color={LEAD}>{`${footer.shown}${cursor}`}</Text>
          <Text>{' '}</Text>
          {squares.map(kind => (
            <Text color={kind === 'run' ? (breathe ? SWARM_HI : SWARM) : kind === 'ok' ? DONE : FAIL}>■</Text>
          ))}
          <Text color={LINE}>{` ${clockText(t)}`}</Text>
        </Box>
      </Box>
    )
  })
}
