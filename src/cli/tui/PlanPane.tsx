/**
 * The plan pane (W4-T3). Pure display plus its own scroll state: the goal, "done/total" with the plan's status word,
 * then one line per step (status glyph, title, owner) with its note dim underneath when every note fits. The goal and
 * progress lines stay put; the steps scroll while focused (Up/Down, PageUp/PageDown, Home/End). Strings arrive
 * sanitized. A screen reader gets the step status as a word instead of a glyph.
 */
import { useEffect, useRef, useState } from 'react'
import { useFocusHandler, useTuiEnv } from './context'
import { observePlan, planProgress, type PlanObservation } from './planProgress'
import { asciiOnly } from './theme'
import type { PlanPaneProps, PlanStepView, Tone, TuiEnv } from './types'
import { PaneLines, paneHeading, alignSegs, cutSegs, moveIndex, navKey, type PaneLine } from './panes/lines'

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

export function PlanPane(props: PlanPaneProps) {
  const env = useTuiEnv()
  const width = Math.max(0, Math.floor(props.width))
  const height = Math.max(0, Math.floor(props.height))
  const [top, setTop] = useState(0)
  const plan = props.plan
  const [now, setNow] = useState(Date.now)
  const observation = useRef<PlanObservation | undefined>(undefined)
  observation.current = observePlan(plan, Date.now(), observation.current)
  const estimating = !!plan && plan.status !== 'done' && plan.status !== 'blocked' && !plan.waiting
    && !plan.steps.some(step => step.status === 'blocked')
    && plan.runStatus === 'running' && width > 0 && height >= 6 && !env.screenReader
  useEffect(() => {
    if (!estimating) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [estimating])

  const head: PaneLine[] = []
  const steps: PaneLine[] = []
  if (plan) {
    head.push({ key: 'title', segs: paneHeading('Plan', width, props.focused, env) })
    head.push({ key: 'goal', segs: cutSegs([{ text: plan.goal || 'No goal set' }], width, env) })
    head.push({ key: 'progress', segs: cutSegs([{ text: `${plan.done}/${plan.total} done`, dim: true }, { text: plan.statusWord ? `  ${plan.statusWord}` : '' }], width, env) })
    if (height >= 6) {
      const progress = planProgress(plan, Math.max(now, Date.now()), observation.current)
      const eta = asciiOnly(env) ? progress.eta.replace('…', '...') : progress.eta
      const suffix = ` ${progress.percent}%${asciiOnly(env) ? ' | ' : ' · '}${eta}`
      const cells = Math.max(0, Math.min(16, width - suffix.length - 2))
      const filled = Math.round(cells * progress.percent / 100)
      head.push({ key: 'bar', segs: cutSegs(env.screenReader
        ? [{ text: `Progress ${progress.percent}%. ${progress.eta}` }]
        : [
          { text: cells ? '[' : '', dim: true },
          { text: (asciiOnly(env) ? '#' : '━').repeat(filled), tone: progress.percent === 100 ? 'ok' : 'running' },
          { text: (asciiOnly(env) ? '-' : '─').repeat(cells - filled), dim: true },
          { text: `${cells ? ']' : ''}${suffix}`, dim: true }
        ], width, env) })
    }
    const bodyH = Math.max(0, height - head.length)
    const withNotes = plan.steps.some((s) => s.note) && plan.steps.length + plan.steps.filter((s) => s.note).length <= bodyH
    for (const step of plan.steps) {
      const tone = STEP_TONE[step.status]
      const left = [
        { text: `${stepMarker(step.status, env)} `, tone },
        { text: step.title, dim: step.status === 'skipped' }
      ]
      const owner = step.owner ? { text: step.owner, dim: true } : undefined
      steps.push({ key: `step:${step.id}`, segs: alignSegs(left, owner, width, env) })
      if (withNotes && step.note) steps.push({ key: `note:${step.id}`, segs: cutSegs([{ text: `    ${step.note}`, dim: true }], width, env) })
    }
  } else {
    head.push({ key: 'title', segs: paneHeading('Plan', width, props.focused, env) })
    head.push({ key: 'empty', segs: cutSegs([{ text: 'No plan yet', dim: true }], width, env) })
  }

  const bodyH = Math.max(0, height - head.length)
  const maxTop = Math.max(0, steps.length - bodyH)
  const shownTop = Math.min(top, maxTop)
  const topRef = useRef(shownTop)
  topRef.current = shownTop

  useFocusHandler(
    'plan',
    (e) => {
      const k = navKey(e)
      if (!k) return false
      // Scrolling moves the first visible step line; End shows the last page.
      const next = k === 'end' ? maxTop : moveIndex(topRef.current, k, maxTop + 1, Math.max(1, bodyH - 1))
      topRef.current = next
      setTop(next)
      return true
    },
    props.focused
  )

  const lines = [...head, ...steps.slice(shownTop, shownTop + bodyH)]
  return <PaneLines width={width} height={height} lines={lines} env={env} />
}
