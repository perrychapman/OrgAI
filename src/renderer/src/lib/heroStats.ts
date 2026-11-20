import type { CostView } from './cost'
import { plural } from '../components/dashboard/dashboardProjects'

/**
 * The Dashboard hero's stat tiles (visual pass over docs/design/dashboard-overhaul.md section 5): which tiles show, in what
 * order, with what figure, label, tone and accessible sentence. Pure: plain numbers and a cost view in, tile models out.
 *
 * Rules: at most 5 tiles; order waiting, working, finished, today, spend; a tile with nothing to say (zero) is left out,
 * except the waiting tile, which becomes the calm "All clear" tile so the row is never a row of zeros; an unknown cost is
 * never $0 and a partial one keeps its "+"; before history loads only the live facts (waiting, working) can show.
 */

export type HeroStat = 'waiting' | 'working' | 'finished' | 'today' | 'spend'
/** Semantic tone, mapped to existing tokens in dashboard-greeting.css. */
export type HeroTone = 'warning' | 'info' | 'success' | 'accent' | 'neutral' | 'danger'
/** Which section a tile leads to; the component maps it to the section's h2. */
export type HeroTarget = 'needs' | 'working' | 'resume' | 'week'
/** The glyph a tile wears; the component maps it to a lucide icon. */
export type HeroGlyph = 'decision' | 'reply' | 'clear' | 'working' | 'finished' | 'failed' | 'today' | 'spend'

export const HERO_MAX_TILES = 5

export const HERO_TARGET_TITLES: Record<HeroTarget, string> = {
  needs: 'Waiting on you',
  working: 'Working now',
  resume: 'Pick up where you left off',
  week: 'Your week'
}

export interface HeroInput {
  /** No projects: no tiles, the one welcome line. */
  firstLaunch: boolean
  /** Every project's history is loaded. */
  ready: boolean
  /** At least one run exists anywhere. Only read once `ready`. */
  anyRunEver: boolean
  /** Open decisions (the bell). */
  decisions: number
  /** Idle live runs waiting for the person's reply (not decisions). */
  awaitingReply: number
  workingAgents: number
  workingRuns: number
  /** Runs finished and failed since the person was last here (or in the past 7 days when `longAgo`). */
  finished: number
  failed: number
  longAgo: boolean
  /** Work runs started today. */
  runsToday: number
  /** The week's cost as `costView` words it; `shown` is false for a reported zero or nothing spent. */
  spend: { shown: boolean; view: Pick<CostView, 'kind' | 'text'> }
}

export interface HeroTile {
  stat: HeroStat
  tone: HeroTone
  glyph: HeroGlyph
  /** The big figure as drawn ("3", "$4.20", "$4.20+", "unknown"). */
  figure: string
  /** True for a word instead of a number ("unknown"): drawn smaller so it fits. */
  figureWord: boolean
  /** One to three words, sentence case. */
  label: string
  /** The full fact as a sentence without a full stop ("2 decisions waiting on you"). */
  summary: string
  target: HeroTarget
  /** True for the calm all-clear tile. */
  calm: boolean
}

export interface HeroModel {
  tiles: HeroTile[]
  /** True when a visible sentence (the brief) is the better reading: first launch, no runs ever, all quiet. */
  sentence: boolean
  /** True while the row has nothing yet but the tiles are expected once history loads (keeps the row's height). */
  pending: boolean
}

const clamp = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

function waitingTile(i: HeroInput): HeroTile {
  const d = clamp(i.decisions)
  const r = clamp(i.awaitingReply)
  if (d > 0) {
    return { stat: 'waiting', tone: 'warning', glyph: 'decision', figure: String(d), figureWord: false, label: 'Waiting on you', summary: `${plural(d, 'decision', 'decisions')} waiting on you`, target: 'needs', calm: false }
  }
  if (r > 0) {
    // Not a decision card, but "nothing is waiting" would be untrue.
    return { stat: 'waiting', tone: 'warning', glyph: 'reply', figure: String(r), figureWord: false, label: 'Awaiting reply', summary: `${plural(r, 'run', 'runs')} idle and awaiting reply`, target: 'working', calm: false }
  }
  return { stat: 'waiting', tone: 'success', glyph: 'clear', figure: 'All clear', figureWord: true, label: 'Nothing waiting', summary: 'All clear, nothing waiting on you', target: 'needs', calm: true }
}

function workingTile(i: HeroInput): HeroTile | null {
  const a = clamp(i.workingAgents)
  const r = clamp(i.workingRuns)
  if (a > 0) {
    const runs = plural(Math.max(1, r), 'run', 'runs')
    return { stat: 'working', tone: 'info', glyph: 'working', figure: String(a), figureWord: false, label: a === 1 ? 'Agent working' : 'Agents working', summary: `${plural(a, 'agent', 'agents')} working in ${runs}`, target: 'working', calm: false }
  }
  if (r > 0) {
    return { stat: 'working', tone: 'info', glyph: 'working', figure: String(r), figureWord: false, label: r === 1 ? 'Run working' : 'Runs working', summary: `${plural(r, 'run', 'runs')} working`, target: 'working', calm: false }
  }
  return null
}

function finishedTile(i: HeroInput): HeroTile | null {
  const f = clamp(i.finished)
  const x = clamp(i.failed)
  // Label words stay inside the accessible name (WCAG 2.5.3), so the sentence says "newly" and "this week" too.
  const when = i.longAgo ? 'this week' : 'since you were last here'
  if (f > 0) {
    const failed = x > 0 ? ` and ${x} failed` : ''
    return { stat: 'finished', tone: 'success', glyph: 'finished', figure: String(f), figureWord: false, label: i.longAgo ? 'Finished this week' : 'Newly finished', summary: `${plural(f, 'run', 'runs')} newly finished${failed} ${when}`, target: 'resume', calm: false }
  }
  if (x > 0) {
    return { stat: 'finished', tone: 'danger', glyph: 'failed', figure: String(x), figureWord: false, label: i.longAgo ? 'Failed this week' : 'Newly failed', summary: `${plural(x, 'run', 'runs')} newly failed ${when}`, target: 'resume', calm: false }
  }
  return null
}

function todayTile(i: HeroInput): HeroTile | null {
  const n = clamp(i.runsToday)
  if (n === 0) return null
  return { stat: 'today', tone: 'accent', glyph: 'today', figure: String(n), figureWord: false, label: n === 1 ? 'Run today' : 'Runs today', summary: `${plural(n, 'run', 'runs')} today`, target: 'week', calm: false }
}

function spendTile(i: HeroInput): HeroTile | null {
  const { shown, view } = i.spend
  if (!shown || (view.kind !== 'known' && view.kind !== 'partial' && view.kind !== 'unknown')) return null
  const word = view.kind === 'unknown'
  const said = view.kind === 'partial' ? `at least ${view.text.replace(/\+$/, '')}` : view.text
  return { stat: 'spend', tone: 'neutral', glyph: 'spend', figure: view.text, figureWord: word, label: 'Spend this week', summary: `Spend this week: ${said}`, target: 'week', calm: false }
}

/** The tiles for the current facts (see the file comment for the rules). */
export function heroStats(i: HeroInput): HeroModel {
  if (i.firstLaunch) return { tiles: [], sentence: true, pending: false }
  const live: HeroTile[] = [clamp(i.decisions) > 0 || clamp(i.awaitingReply) > 0 ? waitingTile(i) : null, workingTile(i)].filter((t): t is HeroTile => t !== null)
  if (!i.ready) return { tiles: live, sentence: false, pending: live.length === 0 }
  // Projects but no run ever and nothing live: nothing to count, so one sentence says so.
  if (!i.anyRunEver && live.length === 0) return { tiles: [], sentence: true, pending: false }
  const tiles = [waitingTile(i), workingTile(i), finishedTile(i), todayTile(i), spendTile(i)].filter((t): t is HeroTile => t !== null).slice(0, HERO_MAX_TILES)
  // Only the calm tile left: say what has not changed in words too.
  const quiet = tiles.length === 1 && tiles[0]!.calm
  return { tiles, sentence: quiet, pending: false }
}

/** The tile's accessible name: its sentence plus where it leads when it is a button. */
export function heroTileName(tile: HeroTile, interactive: boolean): string {
  return interactive ? `${tile.summary}. Go to ${HERO_TARGET_TITLES[tile.target]}.` : `${tile.summary}.`
}
