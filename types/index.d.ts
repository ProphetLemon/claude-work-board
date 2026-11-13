export type AgentRow = {
  id: string
  toolUseId: string
  description: string
  type: string
  model: string
  status: string
  startedAt: number
  endedAt?: number
  tools: number
  lastToolAt?: number
  lastTool?: string
  background: boolean
}

export type LogRow = { at: number; who: 'lead' | 'advisor' | 'swarm'; text: string }

export type MainRow = {
  model: string
  effort: string
  toolCalls: number
  steps: number
  advisorCalls: number
  advisorTimes: number[]
  lastAdvisorAt?: number
  busy: boolean
  turnStartedAt?: number
  startedAt: number
  // Paths the lead changed, newest first. Absent in a value stored before it.
  files?: string[]
  // How long the last finished turn ran, and the last advisor call took.
  lastTurnMs?: number
  lastAdvisorMs?: number
}

export type LimitRow = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageRow = {
  tokens?: number
  window: number
  percent: number
  usd?: number
  limits: LimitRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'work-board': {
      agents: Shaped<AgentRow[]>
      log: Shaped<LogRow[]>
      main: Shaped<MainRow>
      usage: Shaped<UsageRow>
    }
  }
}
