import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { isVirtualProjectId } from '@shared/types'
import { isRunLive, useAppStore } from '../../store/useAppStore'
import { useReducedMotion } from '../../lib/canvas'
import { PULSE_RECOMPUTE_MS, SIGNAL_WINDOW_MS, pulseInput, pulseModel, pulseStateWord, type PulseModel, type PulseNode } from '../../lib/teamPulse'

export interface TeamPulseProps {
  /** Page arrival in progress: lines trace from the root outward, then nodes pop in. */
  arriving: boolean
  /** Pause motion (layout.motionPaused) or reduced motion: no breathing, no signal; static cues stay. */
  paused: boolean
  /** With no open run, the pinned (else most recent) project's team is drawn at rest. */
  restProjectId: string | null
}

interface Published {
  model: PulseModel | null
  /** Node keys that appeared since the last published picture (they pop in; the first picture has none). */
  fresh: ReadonlySet<string>
}

const NO_FRESH: ReadonlySet<string> = new Set()

function computeModel(restProjectId: string | null, since: number): PulseModel | null {
  const s = useAppStore.getState()
  const known = new Set(s.projects.map((p) => p.id))
  const runs = Object.values(s.runs)
    .filter((r) => isRunLive(r) && (isVirtualProjectId(r.summary.projectId) || known.has(r.summary.projectId)))
    .map((r) => ({
      id: r.summary.id,
      projectId: r.summary.projectId,
      startedAt: r.summary.startedAt,
      ...(r.roster ? { roster: r.roster } : {}),
      agents: r.agents,
      messages: r.messages
    }))
  return pulseModel(pulseInput(runs, s.projects, s.virtualProjects, restProjectId, Date.now(), since))
}

/**
 * The picture's model, recomputed at most every PULSE_RECOMPUTE_MS (trailing) after a store change and published only
 * when what is drawn changed, so a burst of agent events renders once and an unrelated event renders nothing. A timer
 * also retires a signal when its message leaves the window.
 */
function usePulse(restProjectId: string | null): Published {
  const sinceRef = useRef(Date.now())
  const [pub, setPub] = useState<Published>(() => ({ model: computeModel(restProjectId, sinceRef.current), fresh: NO_FRESH }))
  useEffect(() => {
    let timer: number | undefined
    let expiry: number | undefined
    let last = ''
    let keys: Set<string> | null = null
    const flush = (): void => {
      timer = undefined
      if (expiry !== undefined) window.clearTimeout(expiry)
      expiry = undefined
      const next = computeModel(restProjectId, sinceRef.current)
      const sig = JSON.stringify(next)
      if (sig !== last) {
        const nextKeys = new Set((next?.nodes ?? []).map((n) => n.key))
        const fresh = keys && last !== '' ? new Set([...nextKeys].filter((k) => !(keys as Set<string>).has(k))) : NO_FRESH
        last = sig
        keys = nextKeys
        setPub({ model: next, fresh })
      }
      if (next && next.signals.length > 0) {
        const due = Math.min(...next.signals.map((s) => s.at)) + SIGNAL_WINDOW_MS - Date.now()
        expiry = window.setTimeout(flush, Math.max(due, 0) + 50)
      }
    }
    flush()
    const unsub = useAppStore.subscribe(() => {
      if (timer === undefined) timer = window.setTimeout(flush, PULSE_RECOMPUTE_MS)
    })
    return () => {
      unsub()
      if (timer !== undefined) window.clearTimeout(timer)
      if (expiry !== undefined) window.clearTimeout(expiry)
    }
  }, [restProjectId])
  return pub
}

function Node({ node, motion, arriving, fresh }: { node: PulseNode; motion: boolean; arriving: boolean; fresh: boolean }): ReactElement {
  const breathing = motion && node.breath !== undefined
  const cls = arriving ? 'dash-pulse-node motion-pop' : fresh && motion ? 'dash-pulse-node dash-pulse-new' : 'dash-pulse-node'
  const style = { '--role': node.color, '--lvl': Math.min(node.depth, 3) } as CSSProperties
  return (
    <g className={cls} data-testid="dash-pulse-node" data-state={node.state} data-agent={node.id} data-depth={node.depth} style={style}>
      <title>{`${node.label}: ${pulseStateWord(node.state)}`}</title>
      {(node.state === 'working' || node.state === 'waiting' || node.state === 'failed') && (
        <circle
          className="dash-pulse-halo"
          cx={node.x}
          cy={node.y}
          r={node.r + 3}
          data-breathe={breathing ? '' : undefined}
          style={breathing ? ({ '--i': node.breath } as CSSProperties) : undefined}
        />
      )}
      <circle className="dash-pulse-dot" cx={node.x} cy={node.y} r={node.r} />
    </g>
  )
}

/**
 * Team pulse: the live org chart in miniature. A picture with a caption; the rows in Right now remain the way to act, so
 * nothing in it takes focus. Working nodes breathe and a signal dot travels the line between two agents that just
 * messaged (the only two loops); paused or reduced motion keep the static halo and drop both.
 */
export function TeamPulse({ arriving, paused, restProjectId }: TeamPulseProps): ReactElement | null {
  const reduced = useReducedMotion()
  const { model, fresh } = usePulse(restProjectId)
  if (!model) return null
  const motion = !paused && !reduced
  const draw = arriving && motion
  const { caption } = model
  return (
    <figure className="dash-pulse" data-testid="dash-pulse" data-mode={model.mode} data-count={model.nodes.length} data-more={model.more} data-motion={motion ? '' : undefined} data-arriving={draw ? '' : undefined}>
      <svg
        className="dash-pulse-svg"
        viewBox={`0 0 ${model.width} ${model.height}`}
        width={model.width}
        height={model.height}
        style={{ aspectRatio: `${model.width} / ${model.height}` }}
        aria-hidden="true"
        focusable="false"
      >
        <g className="dash-pulse-lines">
          {model.lines.map((l) => (
            <path
              key={l.key}
              className={draw ? 'dash-pulse-line motion-draw-line' : fresh.has(l.key) && motion ? 'dash-pulse-line motion-draw-line dash-pulse-new-line' : 'dash-pulse-line'}
              d={l.d}
              pathLength={1}
              style={{ '--line': l.color, '--lvl': Math.min(l.level - 1, 3) } as CSSProperties}
            />
          ))}
        </g>
        {motion &&
          model.signals.map((s) => (
            <circle key={s.key} className="dash-pulse-signal" data-testid="dash-pulse-signal" data-from={s.from} data-to={s.to} r={3} style={{ offsetPath: `path("${s.d}")` }} />
          ))}
        <g className="dash-pulse-nodes">
          {model.nodes.map((n) => (
            <Node key={n.key} node={n} motion={motion} arriving={draw} fresh={fresh.has(n.key)} />
          ))}
        </g>
      </svg>
      <figcaption className="dash-pulse-caption" data-testid="dash-pulse-caption">
        {caption.parts.length === 0 ? (
          caption.text
        ) : (
          <>
            {caption.lead}{' '}
            {caption.parts.map((p, i) => (
              <span key={p.state}>
                <span className="dash-pulse-key" data-state={p.state}>
                  {p.text}
                </span>
                {i < caption.parts.length - 1 ? ', ' : ''}
              </span>
            ))}
            .{caption.tail ? ` ${caption.tail}` : ''}
          </>
        )}
      </figcaption>
    </figure>
  )
}
