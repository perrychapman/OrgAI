/** Compact run checklist: pinned progress/ETA and as many one-line tasks as fit. */
import { useEffect, useRef, useState } from 'react'
import { useFocusHandler, useTuiEnv } from './context'
import { observePlan, planProgress, type PlanObservation } from './planProgress'
import { namesText } from './planGraph'
import { asciiOnly, glyphs } from './theme'
import { textWidth, truncateEnd } from './panes/text'
import type { PlanPaneProps, PlanStepView, Tone, TuiEnv } from './types'
import { PaneLines, alignSegs, cutSegs, moveIndex, navKey, type PaneLine, type Seg } from './panes/lines'

type StepStatus = PlanStepView['status']

const STEP_UNICODE: Record<StepStatus, string> = {
  pending: '○',
  in_progress: '◐',
  done: '✓',
  blocked: '!',
  skipped: '–'
}

const STEP_ASCII: Record<StepStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  done: '[x]',
  blocked: '[!]',
  skipped: '[-]'
}

const STEP_WORD: Record<StepStatus, string> = {
  pending: 'to do',
  in_progress: 'in progress',
  done: 'done',
  blocked: 'blocked',
  skipped: 'skipped'
}

const STEP_TONE: Record<StepStatus, Tone | undefined> = {
  pending: undefined,
  in_progress: 'running',
  done: 'ok',
  blocked: 'danger',
  skipped: 'dim'
}

/** The marker before a step title: a glyph, or the status word for a screen reader. */
export function stepMarker(status: StepStatus, env: TuiEnv): string {
  if (env.screenReader) return `${STEP_WORD[status] ?? status}:`
  return (asciiOnly(env) ? STEP_ASCII : STEP_UNICODE)[status] ?? '?'
}

/** Display a short phrase, preserving an ellipsis whenever detail was omitted. */
export function taskLabel(title: string, width: number, env: TuiEnv): string {
  const text = title.replace(/\s+/g, ' ').trim()
  const first = text.split(/[;,](?=\s)/)[0]!
  const phrase = first.length >= 12 ? first : text
  const ellipsis = asciiOnly(env) ? '...' : '…'
  const limit = Math.max(0, Math.min(30, width))
  if (phrase === text && textWidth(text) <= limit) return text
  const words = phrase.split(' ')
  let short = ''
  for (const word of words) {
    const next = short ? `${short} ${word}` : word
    if (textWidth(next + ellipsis) > limit) break
    short = next
  }
  return short ? short + ellipsis : truncateEnd(phrase, limit, ellipsis)
}

/** What an open step of a graph plan adds after its title: running, ready or waiting on (at most two titles), and its pick. */
export function graphSegs(step: PlanStepView, env: TuiEnv): Seg[] {
  const f = step.flow
  const sep = ` ${glyphs(env).bullet} `
  const out: Seg[] = []
  if (f) {
    const on = f.state === 'waiting' ? namesText((f.on ?? []).map((t) => taskLabel(t, 18, env))) : ''
    out.push({ text: `${sep}${f.state === 'waiting' ? `waiting on ${on}` : f.state}`, tone: f.state === 'running' ? 'running' : undefined, dim: f.state !== 'running' })
  }
  if (step.staff && f) out.push({ text: `${sep}${step.staff}`, dim: true })
  return out
}

/** The ETA is a rough pace estimate: refreshing it every 10 s is plenty. */
export const PLAN_ETA_REFRESH_MS = 10_000

export function PlanPane(props: PlanPaneProps) {
  const env = useTuiEnv()
  const width = Math.max(0, Math.floor(props.width))
  const height = Math.max(0, Math.floor(props.height))
  const [top, setTop] = useState<number | undefined>(undefined)
  const plan = props.plan
  useEffect(() => setTop(undefined), [props.focused, plan?.runId, plan?.goal])
  const [now, setNow] = useState(Date.now)
  const observation = useRef<PlanObservation | undefined>(undefined)
  observation.current = observePlan(plan, Date.now(), observation.current)
  const estimating = !!plan && plan.status !== 'done' && plan.status !== 'blocked' && !plan.waiting
    && !plan.steps.some(step => step.status === 'blocked')
    && plan.runStatus === 'running' && width > 0 && height >= 2 && !env.screenReader
  useEffect(() => {
    if (!estimating) return undefined
    const timer = setInterval(() => setNow(Date.now()), PLAN_ETA_REFRESH_MS)
    return () => clearInterval(timer)
  }, [estimating])

  const head: PaneLine[] = [{ key: 'title', segs: alignSegs(
    [{ text: 'Tasks', bold: true, tone: props.focused ? 'accent' : undefined }],
    plan ? { text: `${plan.done}/${plan.total} done`, dim: true } : undefined, width, env
  ) }]
  const steps: PaneLine[] = []
  if (plan) {
    const progress = planProgress(plan, Math.max(now, Date.now()), observation.current)
    const stopped = ['Blocked', 'Paused', 'Waiting for you', 'Idle', 'Stopping', 'Run ended', 'Run failed'].includes(progress.eta)
    let eta = stopped ? `${progress.eta === 'Waiting for you' ? 'Waiting' : progress.eta} · ${env.screenReader ? 'ETA unavailable' : 'ETA —'}` : progress.eta
    if (asciiOnly(env)) eta = eta.replace('…', '...').replace('·', '|').replace('—', '-')
    const suffix = ` ${progress.percent}%${asciiOnly(env) ? ' | ' : ' · '}${eta}`
    const cells = Math.max(0, Math.min(8, width - textWidth(suffix) - 2))
    const filled = Math.round(cells * progress.percent / 100)
    head.push({ key: 'bar', segs: cutSegs(env.screenReader
      ? [{ text: `Progress ${progress.percent}%. ${eta}` }]
      : [
        { text: cells ? '[' : '', dim: true },
        { text: (asciiOnly(env) ? '#' : '━').repeat(filled), tone: progress.percent === 100 ? 'ok' : 'running' },
        { text: (asciiOnly(env) ? '-' : '─').repeat(cells - filled), dim: true },
        { text: `${cells ? ']' : ''}${suffix}`, dim: true }
      ], width, env) })
    for (const step of plan.steps) {
      const marker = `${stepMarker(step.status, env)} `
      steps.push({ key: `step:${step.id}`, segs: cutSegs([
        { text: marker, tone: STEP_TONE[step.status] },
        { text: taskLabel(step.title, width - textWidth(marker), env), dim: step.status === 'skipped' },
        ...graphSegs(step, env)
      ], width, env) })
    }
  } else head.push({ key: 'empty', segs: cutSegs([{ text: 'No plan yet', dim: true }], width, env) })

  const room = Math.max(0, height - head.length)
  const overflow = steps.length > room && room >= 2
  const bodyH = Math.max(0, room - (overflow ? 1 : 0))
  const maxTop = Math.max(0, steps.length - bodyH)
  const current = plan?.steps.findIndex(step => step.status === 'blocked') ?? -1
  const active = plan?.steps.findIndex(step => step.status === 'in_progress') ?? -1
  const working = current >= 0 ? current : active >= 0 ? active : plan?.steps.findIndex(step => step.status === 'pending') ?? -1
  const autoTop = Math.min(maxTop, Math.max(0, working - (bodyH > 1 ? 1 : 0)))
  const shownTop = props.focused && top !== undefined ? Math.min(top, maxTop) : autoTop
  const topRef = useRef(shownTop)
  topRef.current = shownTop

  useFocusHandler(
    'plan',
    (e) => {
      const k = navKey(e)
      if (!k) return false
      // Progress stays pinned while only the compact task window scrolls.
      const next = k === 'end' ? maxTop : moveIndex(topRef.current, k, maxTop + 1, Math.max(1, bodyH - 1))
      topRef.current = next
      setTop(next)
      return true
    },
    props.focused
  )

  const lines = [...head, ...steps.slice(shownTop, shownTop + bodyH)]
  if (overflow) lines.push({ key: 'more', segs: cutSegs([{ text: `${shownTop + 1}${asciiOnly(env) ? '-' : '–'}${Math.min(steps.length, shownTop + bodyH)} of ${steps.length}${asciiOnly(env) ? ' | ' : ' · '}${props.focused ? 'Up/Down scroll' : 'Tab to view'}`, dim: true }], width, env) })
  return <PaneLines width={width} height={height} lines={lines} env={env} />
}
