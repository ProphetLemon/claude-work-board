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
function engine(on: On) {
  const clock = mock.clock(on, { now: START })
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
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
