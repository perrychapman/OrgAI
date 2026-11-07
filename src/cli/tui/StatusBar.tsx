/**
 * The status bar (W4-T3): one line with the project, the followed run (tag and title), its status word (from
 * statusText, via the selectors) in its tone, cost, "N need you", live run count, connection state and the read-only
 * reason, then a fresh notice and the key hint. A screen reader gets plain words separated by commas, never glyphs.
 *
 * Fitting (issue #26): the key hint and a fresh notice are what the user needs, so the status segments give way first,
 * in this order: the run chips shrink to "R1* R2! +N" and then "+N live", the cost goes, the run title is cut at a word
 * boundary (then dropped). Then the hint loses items from its end, at separators, never mid-word, down to one item.
 * The project name ("where am I") is the last thing to go (issue #34). When only one of notice and hint fits, a danger / warn notice wins for its lifetime, otherwise the
 * hint. A notice is fresh for TUI_NOTICE_TTL_MS from `notice.at` (clock: props.now ?? Date.now); the bar re-renders at
 * expiry by itself. One separator rule everywhere (theme.ts separatorFor).
 */
import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import { useTuiEnv } from './context'
import { hintItems } from './keymap'
import { separatorFor } from './theme'
import { TUI_NOTICE_TTL_MS, type ConnectionState, type RunChip, type StatusBarProps, type StatusSummary, type Tone, type TuiEnv, type TuiNotice } from './types'
import { cutSegs, styleFor, type Seg } from './panes/lines'
import { sliceToWidth, textWidth } from './panes/text'

const CONNECTION_TEXT: Record<ConnectionState, { text: string; tone?: Tone } | undefined> = {
  connecting: { text: 'Connecting', tone: 'dim' },
  live: undefined,
  reconnecting: { text: 'Reconnecting', tone: 'warn' },
  gone: { text: 'Connection lost', tone: 'danger' }
}

export function needsYouText(n: number): string {
  return `${n} need${n === 1 ? 's' : ''} you`
}

function chipText(c: RunChip, env: Pick<TuiEnv, 'screenReader'>): string {
  if (env.screenReader) return `${c.tag}${c.followed ? ' followed' : ''}${c.needsYou ? ' needs you' : ''}`
  return `${c.tag}${c.followed ? '*' : ''}${c.needsYou ? '!' : ''}`
}

/** Live runs as chips (F8): `R1*` followed, `!` has an open decision; a screen reader gets words. At most 6, then "+N". */
export function runChipsText(chips: readonly RunChip[], env: Pick<TuiEnv, 'screenReader'>): string {
  const shown = chips.slice(0, 6).map((c) => chipText(c, env))
  if (chips.length > 6) shown.push(`+${chips.length - 6}`)
  return shown.join(env.screenReader ? '; ' : ' ')
}

/** The short chips: the followed run and the first run that needs you, then "+N" for the rest ("R1* R2! +3"). */
export function compactChipsText(chips: readonly RunChip[], env: Pick<TuiEnv, 'screenReader'>): string {
  const picked: RunChip[] = []
  const followed = chips.find((c) => c.followed)
  if (followed) picked.push(followed)
  const needs = chips.find((c) => c.needsYou && !picked.includes(c))
  if (needs) picked.push(needs)
  if (picked.length === 0 && chips[0]) picked.push(chips[0])
  const rest = chips.length - picked.length
  const shown = picked.map((c) => chipText(c, env))
  if (rest > 0) shown.push(`+${rest}`)
  return shown.join(env.screenReader ? '; ' : ' ')
}

/** How far the status segments have given way (0 = everything). */
interface Level {
  chips: 'full' | 'compact' | 'count'
  cost: boolean
  /** Longest run title in columns; 0 = no title. */
  title: number
  project: boolean
}

const LEVELS: readonly Level[] = [
  { chips: 'full', cost: true, title: Infinity, project: true },
  { chips: 'compact', cost: true, title: Infinity, project: true },
  { chips: 'count', cost: true, title: Infinity, project: true },
  { chips: 'count', cost: false, title: Infinity, project: true },
  { chips: 'count', cost: false, title: 24, project: true },
  { chips: 'count', cost: false, title: 12, project: true },
  { chips: 'count', cost: false, title: 0, project: true }
]

/** The very last resort (issue #34): only after the hint has shrunk to one item does the project name go. */
const NO_PROJECT: Level = { chips: 'count', cost: false, title: 0, project: false }

/** `title` cut to `max` columns at a word boundary with an ellipsis; '' when no whole word fits. */
function cutTitle(title: string, max: number, ellipsis: string): string {
  if (max === Infinity || textWidth(title) <= max) return title
  if (max <= 0) return ''
  const room = max - textWidth(ellipsis)
  if (room <= 0) return ''
  const head = sliceToWidth(title, room)
  // A cut that fell on a word boundary keeps all of `head`; otherwise back up to the last space.
  const words = title[head.length] === ' ' ? head : head.slice(0, Math.max(0, head.lastIndexOf(' ')))
  const text = words.trimEnd()
  return text ? `${text}${ellipsis}` : ''
}

function buildSegs(s: StatusSummary, env: Pick<TuiEnv, 'screenReader'>, level: Level, ellipsis: string): Seg[] {
  const out: Seg[] = []
  if (s.title) out.push({ text: s.title, tone: 'accent', bold: true })
  if (s.projectName && level.project) out.push({ text: s.projectName, bold: true })
  const title = s.runTitle ? cutTitle(s.runTitle, level.title, ellipsis) : ''
  const run = [s.runTag, title].filter(Boolean).join(' ')
  if (run) out.push({ text: run })
  if (s.statusWord) out.push({ text: s.statusWord, tone: s.tone })
  else out.push({ text: 'Ready', dim: true })
  if (s.costText && level.cost) out.push({ text: s.costText, dim: true })
  // "0 need you" means nothing before there is a project or a run (onboarding, R2-L5).
  if (s.needsYou > 0 || s.projectName || s.runTag) out.push({ text: needsYouText(s.needsYou), tone: s.needsYou > 0 ? 'warn' : 'dim' })
  const chips = s.runChips
  if (chips && chips.length > 0) {
    const tone = chips.some((c) => c.needsYou) ? { tone: 'warn' as const } : { dim: true }
    if (level.chips === 'count') out.push({ text: `${chips.length} live`, ...tone })
    else {
      const text = level.chips === 'compact' ? compactChipsText(chips, env) : runChipsText(chips, env)
      out.push({ text: env.screenReader ? `live runs: ${text}` : text, ...tone })
    }
  } else if (s.liveRuns > 0) out.push({ text: `${s.liveRuns} live`, dim: true })
  const conn = CONNECTION_TEXT[s.connection]
  if (conn) out.push(conn)
  if (s.readOnlyReason) out.push({ text: s.readOnlyReason, tone: 'warn' })
  return out
}

/** The status segments (without separators). */
export function statusSegments(s: StatusSummary, env: Pick<TuiEnv, 'screenReader'> = { screenReader: false }): Seg[] {
  return buildSegs(s, env, LEVELS[0]!, '…')
}

/** Whether a notice is still fresh at `now`. */
export function noticeFresh(notice: TuiNotice | undefined, now: number): boolean {
  return !!notice && now - notice.at < TUI_NOTICE_TTL_MS
}

const urgent = (n: TuiNotice | undefined): boolean => n?.tone === 'danger' || n?.tone === 'warn'

export function StatusBar(props: StatusBarProps) {
  const env = useTuiEnv()
  const clock = props.now ?? Date.now
  const [, setTick] = useState(0)
  const noticeAt = props.notice?.at
  const noticeId = props.notice?.id
  // Re-render at the moment the notice stops being fresh, so the hint comes back with no other event.
  useEffect(() => {
    if (noticeAt === undefined) return undefined
    const left = noticeAt + TUI_NOTICE_TTL_MS - clock()
    if (left <= 0) return undefined
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(left + 5, 2 ** 31 - 1))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeAt, noticeId])

  const width = Math.max(0, Math.floor(props.width))
  if (width === 0) return <Box width={0} height={1} />
  const sep = separatorFor(env)
  const ell = env.unicode && !env.screenReader && !env.dumbTerminal ? '…' : '...'
  const notice = noticeFresh(props.notice, clock()) ? props.notice : undefined
  const gap: Seg = { text: env.screenReader ? '. ' : '   ' }
  const noticeSeg: Seg | undefined = notice ? { text: notice.text, tone: notice.tone ?? 'accent' } : undefined
  const items = props.hints ? hintItems(props.hints, sep) : []
  // The hint with its first `n` items (it keeps its own text when it has no separator to split at).
  const hintSeg = (n: number): Seg | undefined => (items.length === 0 ? undefined : { text: items.slice(0, n).join(sep), dim: true })

  const build = (level: Level, tail: (Seg | undefined)[]): Seg[] => {
    const segs: Seg[] = []
    for (const seg of buildSegs(props.summary, env, level, ell)) {
      if (segs.length > 0) segs.push({ text: sep, dim: true })
      segs.push(seg)
    }
    for (const t of tail) {
      if (!t) continue
      // A screen reader hears ". " between parts; a part that already ends in a stop gets a plain space, not "..".
      const prev = segs[segs.length - 1]?.text ?? ''
      segs.push(env.screenReader && /[.!?]$/.test(prev) ? { text: ' ' } : gap, t)
    }
    return segs
  }
  const fits = (segs: Seg[]): boolean => textWidth(segs.map((s) => s.text).join('')) <= width
  const tryLevels = (tail: (Seg | undefined)[]): Seg[] | undefined => {
    for (const level of LEVELS) {
      const segs = build(level, tail)
      if (fits(segs)) return segs
    }
    return undefined
  }
  const lastP = LEVELS[LEVELS.length - 1]!
  const tryTrimmed = (lead: Seg | undefined, level: Level): Seg[] | undefined => {
    for (let n = items.length - 1; n >= 1; n--) {
      const segs = build(level, [lead, hintSeg(n)])
      if (fits(segs)) return segs
    }
    return undefined
  }
  const noProj = (tail: (Seg | undefined)[]): Seg[] | undefined => {
    const segs = build(NO_PROJECT, tail)
    return fits(segs) ? segs : undefined
  }
  // Order: status segments give way, then the hint's later items, then (last) the project name.
  const fitAll = (lead: Seg | undefined): Seg[] | undefined =>
    tryLevels([lead, hintSeg(items.length)]) ?? tryTrimmed(lead, lastP) ?? noProj([lead, hintSeg(items.length)]) ?? tryTrimmed(lead, NO_PROJECT)
  const fitOnly = (tail: (Seg | undefined)[]): Seg[] | undefined => tryLevels(tail) ?? noProj(tail)

  let chosen: Seg[] | undefined
  if (noticeSeg) {
    chosen = fitAll(noticeSeg)
    // Only one fits: a danger / warn notice wins over the hint (then it may push the whole status out), else the hint.
    if (!chosen && urgent(notice)) chosen = fitOnly([noticeSeg]) ?? (fits([noticeSeg]) ? [noticeSeg] : undefined)
    if (!chosen) chosen = fitAll(undefined)
    if (!chosen) chosen = fitOnly([noticeSeg])
  } else {
    chosen = fitAll(undefined)
  }
  // Nothing fits whole (a very narrow bar): cut the last-resort line with an ellipsis.
  // A danger / warn notice that is wider than the bar is cut by itself: the status words never push it out of sight.
  const line = chosen ?? (noticeSeg && urgent(notice) ? cutSegs([noticeSeg], width, env) : cutSegs(build(NO_PROJECT, [noticeSeg ?? hintSeg(items.length)]), width, env))
  return (
    <Box width={width} height={1} overflow="hidden">
      <Text wrap="truncate-end">
        {line.map((s, i) => (
          <Text key={i} {...styleFor(s, env)}>
            {s.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}
