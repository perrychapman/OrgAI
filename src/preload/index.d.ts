import type { OrgAIApi } from '../shared/types'

declare global {
  interface Window {
    orgai: OrgAIApi
  }
}

export {}
