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
}

declare module 'claude-code' {
  interface PluginState {
    'work-board': {
      agents: Shaped<AgentRow[]>
      log: Shaped<LogRow[]>
      main: Shaped<MainRow>
    }
  }
}
