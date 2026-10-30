import type { RunStatus } from '@shared/types'

/** The one status vocabulary of the app: tabs, run header, history, sidebar and the topbar badge all use these words. */
export type StatusWord = 'Working' | 'Waiting for you' | 'Idle' | 'Paused' | 'Finished' | 'Failed'
export type RunTone = 'live' | 'warn' | 'idle' | 'paused' | 'ok' | 'danger'

export interface RunStatusView {
  word: StatusWord
  tone: RunTone
  /** Extra detail for a tooltip (never replaces the word). */
  note?: string
}

const TONES: Record<StatusWord, RunTone> = {
  Working: 'live',
  'Waiting for you': 'warn',
  Idle: 'idle',
  Paused: 'paused',
  Finished: 'ok',
  Failed: 'danger'
}

/** Maps a run's status to the shared vocabulary. `waiting` (a card, question or blocked plan) wins over the status. */
export function runStatus(status: RunStatus, opts: { waiting?: boolean; endedWithApp?: boolean } = {}): RunStatusView {
  const make = (word: StatusWord, note?: string): RunStatusView => ({ word, tone: TONES[word], ...(note ? { note } : {}) })
  if (opts.waiting) return make('Waiting for you')
  switch (status) {
    case 'starting':
    case 'running':
      return make('Working')
    case 'stopping':
      return make('Working', 'Stopping')
    case 'idle':
      return make('Idle')
    case 'paused':
      return make('Paused')
    case 'error':
      return make('Failed')
    default:
      return make('Finished', opts.endedWithApp ? 'Ended when OrgAI closed' : undefined)
  }
}
