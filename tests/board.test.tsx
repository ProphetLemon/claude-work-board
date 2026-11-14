import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const START = Date.UTC(2026, 10, 13, 12, 0, 0)

const PANE = {
  plugin: 'work-board',
  component: 'Pane',
  requestId: 'work-board',
  props: {
    title: 'Work board',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

// The engine beneath the mod: the calls its session.start makes, answered.
function engine(on: On, list: () => unknown = () => ({ value: [] })) {
  const clock = mock.clock(on, { now: START })
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', list as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // A path naming `denied` is refused, one naming `broken` fails.
  on('tool.call', (_, e) => {
    const path = String((e as { file_path?: unknown }).file_path ?? '')
    if (path.includes('denied')) return { deny: 'not allowed' }
    if (path.includes('broken')) return { isError: true as const, result: 'failed' }
    return { result: {} }
  })
  return clock
}

test('a tool call shows its argument hint in the log', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Called loosely: tsc gives up on the Edit-typed overload (too deep).
  const call = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<unknown>
  await call({
    tool: 'Edit',
    file_path: '/repo/hooks/register.tsx',
    old_string: 'a',
    new_string: 'b',
  })
  // Lets the newest log line finish typing in.
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await ui.find({ type: 'Text', text: /Edit: register\.tsx/ })
  expect(row).toBeDefined()
  await ui.unmount()
})

test('the lead row lists the files the lead changed, newest first', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const call = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<unknown>
  const edit = (file_path: string, more: Record<string, unknown> = {}) =>
    call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', ...more })

  await edit('/repo/a.ts')
  await call({ tool: 'Write', file_path: '/repo/b.ts', content: 'x' })
  await edit('/repo/a.ts')
  await edit('/repo/denied.ts')
  await call({ tool: 'Write', file_path: '/repo/broken.ts', content: 'x' })
  await edit('/repo/sub.ts', { agentId: 'a1' })
  await call({ tool: 'Read', file_path: '/repo/read.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await ui.find({ type: 'Text', text: /^files / })
  expect(row?.text).toBe('files   2 · a.ts, b.ts')
  await ui.unmount()
})

test('no files row before the lead changes a file', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^files / })).toBeUndefined()
  await ui.unmount()
})

test('the idle lead shows how long the last turn took', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'ok', durationMs: 62_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /idle · your turn · last turn 1m02s$/ })).toBeDefined()
  await ui.unmount()
})

test('the advisor shows how long its last call took, when it was timed', async ($, on) => {
  engine(on)
  let uses: { startedAt: number; endedAt: number }[] = []
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      serverToolUses: uses.map((one, i) => ({ id: `s${i}`, name: 'advisor', input: {}, ...one })),
    } as never
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const step = async (index: number) => {
    const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 1 })
    for await (const _ of stream) {
      // The test's step yields nothing; reading it runs the mod's hook.
    }
  }

  uses = [{ startedAt: START + 1000, endedAt: START + 5200 }]
  await step(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /calls · last/ }))?.text).toMatch(/^1 calls · last \d\d:\d\d:\d\d \(4\.2s\)$/)
  await ui.unmount()

  // A response that came whole stamps both alike: no duration to show.
  uses = [{ startedAt: START + 9000, endedAt: START + 9000 }]
  await step(1)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await again.find({ type: 'Text', text: /calls · last/ }))?.text).toMatch(/^2 calls · last \d\d:\d\d:\d\d$/)
  await again.unmount()
})

test('each rate limit shows when it resets', async ($, on) => {
  engine(on)
  const iso = (ms: number) => new Date(START + ms).toISOString()
  const hour = 3_600_000
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: { window: 200_000, tokens: 50_000, percent: 25 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 62, resetsAt: iso(2 * hour) },
        { kind: 'seven_day', percentUsed: 40, resetsAt: iso(76 * hour + 30 * 60_000) },
        { kind: 'spend_limit', percentUsed: 10 },
        { kind: 'old', percentUsed: 5, resetsAt: iso(-hour) },
      ],
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const soon = new Date(START + 2 * hour)
  const clock = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await ui.find({ type: 'Text', text: /^limits / })
  expect(row?.text).toBe(`limits  five hour 62% ↻${clock} · seven day 40% ↻3d4h · spend limit 10% · old 5%`)
  await ui.unmount()
})

test('a narrow pane gets a shorter limits line that keeps every percentage', async ($, on) => {
  engine(on)
  const iso = (ms: number) => new Date(START + ms).toISOString()
  const hour = 3_600_000
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: { window: 200_000, tokens: 50_000, percent: 25 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 62, resetsAt: iso(2 * hour) },
        { kind: 'seven_day', percentUsed: 40, resetsAt: iso(76 * hour + 30 * 60_000) },
      ],
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const limits = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns } })
    const text = (await ui.find({ type: 'Text', text: /^limits / }))?.text
    await ui.unmount()
    return text
  }

  // 40 columns hold 36 of text: short names with reset times fit.
  expect(await limits(40)).toMatch(/^limits {2}5h 62% ↻\d\d:\d\d · 7d 40% ↻3d4h$/)
  // 30 columns hold 26: the reset times go, the percentages stay.
  expect(await limits(30)).toBe('limits  5h 62% · 7d 40%')
})

// A board that runs its sync timer against the agent list a test sets.
function swarm(on: On) {
  const state: { list: unknown[] | 'broken' } = { list: [] }
  const clock = engine(on, () => {
    if (state.list === 'broken') throw new Error('list failed')
    return { value: state.list }
  })
  on('agent.spawn', (_, e) => ({ model: 'claude-opus-5-5', agentId: `id-${e.tool_use_id}` }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { clock, state }
}

type Call = (input: Record<string, unknown>) => Promise<unknown>
const spawnArgs = (id: string, more: Record<string, unknown> = {}) => ({
  tool_use_id: id,
  prompt: 'p',
  description: `task ${id}`,
  subagentType: 'general-purpose',
  parentModel: 'claude-opus-5-5',
  fork: false,
  background: false,
  ...more,
})

// The swarm header and the log, as the pane shows them.
async function board($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0], clock: { advance: (ms: number) => Promise<unknown> }) {
  await clock.advance(3000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const header = (await ui.find({ type: 'Text', text: /\d+ running · \d+ done/ }))?.text
  const log = async (text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
  return { ui, header, log }
}

test('a row whose end was missed closes once the grace has passed', async ($, on) => {
  const { clock } = swarm(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await ($.agent.spawn as unknown as Call)(spawnArgs('t1'))

  // Inside the grace the agent may just not be listed yet.
  await clock.advance(20_000)
  const young = await board($, clock)
  expect(young.header).toMatch(/1 running · 0 done/)
  await young.ui.unmount()

  await clock.advance(30_000)
  const gone = await board($, clock)
  expect(gone.header).toMatch(/0 running · 1 done/)
  expect(await gone.log(/gone: task t1/)).toBe(true)
  await gone.ui.unmount()
})

test('a list that fails to resolve closes nothing', async ($, on) => {
  const { clock, state } = swarm(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await ($.agent.spawn as unknown as Call)(spawnArgs('t1'))

  state.list = 'broken'
  await clock.advance(120_000)
  const shown = await board($, clock)
  expect(shown.header).toMatch(/1 running · 0 done/)
  await shown.ui.unmount()

  // The same row closes once the list resolves again.
  state.list = []
  const later = await board($, clock)
  expect(later.header).toMatch(/0 running · 1 done/)
  await later.ui.unmount()
})

test('a listed agent stays open however long it runs', async ($, on) => {
  const { clock, state } = swarm(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await ($.agent.spawn as unknown as Call)(spawnArgs('t1'))

  state.list = [{ id: 'id-t1', description: 'task t1', type: 'general-purpose', status: 'running' }]
  await clock.advance(120_000)
  const shown = await board($, clock)
  expect(shown.header).toMatch(/1 running · 0 done/)
  await shown.ui.unmount()
})

test('a workflow row is never judged missing and closes on its own turn.complete', async ($, on) => {
  const { clock } = swarm(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await ($.agent.spawn as unknown as Call)(spawnArgs('w1', { workflow: { runId: 'wf_1', agentIndex: 1 } }))

  await clock.advance(120_000)
  const open = await board($, clock)
  expect(open.header).toMatch(/1 running · 0 done/)
  await open.ui.unmount()

  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer', agentId: 'id-w1' } as never)
  const closed = await board($, clock)
  expect(closed.header).toMatch(/0 running · 1 done/)
  await closed.ui.unmount()
})

test('a subagent turn.complete closes its row as completed, killed or failed', async ($, on) => {
  const { clock } = swarm(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const spawn = $.agent.spawn as unknown as Call
  await spawn(spawnArgs('a', { background: true }))
  await spawn(spawnArgs('b'))
  await spawn(spawnArgs('c'))
  const end = (agentId: string, more: Record<string, unknown>) =>
    $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: agentId, reason: 'answer', agentId, ...more } as never)

  await end('id-a', {})
  await end('id-b', { isAborted: true, reason: 'aborted' })
  await end('id-c', { reason: 'error' })
  // A turn of an agent the board has no row for changes nothing.
  await end('id-none', {})

  const shown = await board($, clock)
  expect(shown.header).toMatch(/0 running · 3 done/)
  expect(await shown.log(/done: task a/)).toBe(true)
  expect(await shown.log(/killed: task b/)).toBe(true)
  expect(await shown.log(/failed: task c/)).toBe(true)
  await shown.ui.unmount()
})

test('a subagent turn.complete leaves the lead busy state alone', async ($, on) => {
  const { clock } = swarm(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await ($.agent.spawn as unknown as Call)(spawnArgs('a'))
  await $.turn.start({ text: 'hi', turnId: 'lead' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'x', reason: 'answer', agentId: 'id-a' } as never)

  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /working / })).toBeDefined()
  await ui.unmount()
})
