/**
 * /team (cli-parity 3.7): the project's SAVED roles as a reporting tree, not the run's agents. Enter opens a role's
 * details; the letter keys edit the selected role. Every edit reads the project afresh (projects:get), plans the change
 * with the same function its command uses (teamRoleEdit.ts planRoleSet / planRoleAdd / planRoleMove / planRoleRemove:
 * the same validation, chart rules and "May spend more" sentences) and saves with projects:save, where the host applies
 * the desktop's cleaning. A change that may spend more, and every removal, waits for `y`. Errors show in place.
 *
 * The host lets a project be saved while a run is live; the live run keeps the team it started with, so a save during a
 * run says the change applies from the next run (RunManager: role identity never changes mid-run).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { TOOL_CATALOG, type Project } from '../../shared/types'
import { labelFrom, planRoleAdd, planRoleMove, planRoleRemove, planRoleSet, PROMPT_MAX_CHARS, type RoleEdits, type RolePlan } from '../commands/teamRoleEdit'
import { useFocusHandler } from './context'
import type { TuiConfigApi } from './configApi'
import { charOf, clean, ConfigFrame, contentSize, dialogKey, dialogKeys, dialogLines, errorMessage, isCtrlC, keyIs, moveSel, windowOf, type Dialog, type Message, type PickOption } from './configUi'
import type { PaneLine } from './panes/lines'
import { textWidth, truncateEnd } from './panes/text'
import { effortOptions, managerOptions, maxEffortOptions, minTierOptions, modelEnvOf, modelOptions, roleDetailLines, staffingModeOptions, teamRowSegs, teamRows, type TeamData } from './teamModel'
import { glyphs, separatorFor } from './theme'
import type { InputEvent, TuiEnv } from './types'

export interface TeamViewProps {
  width: number
  height: number
  env: TuiEnv
  projectId: string
  api: TuiConfigApi
  /** Set when this session is read-only: the view shows, edits are refused with this reason. */
  readOnly?: string
  /** A run of this project is live: a save says it applies from the next run. */
  liveRun?: boolean
  /** Opens $EDITOR on the text (the shell suspends the terminal around it); absent: the view names the command. */
  editText?(initial: string): Promise<string>
  onClose(): void
}

export const LIVE_RUN_NOTE = 'The live run keeps the team it started with; this applies from the next run.'

export const LIST_KEYS = ['Up/Down select', 'Enter details', 'm model', 'e effort', 's staffing', 't tools', 'r reparent', 'n rename', 'p prompt', 'a add', 'x remove', 'Esc back']
export const DETAIL_KEYS = ['Up/Down scroll', 'm model', 'e effort', 's staffing', 't tools', 'r reparent', 'n rename', 'p prompt', 'a add', 'x remove', 'Esc back']

export function TeamView(props: TeamViewProps) {
  const { env, api, projectId } = props
  const [data, setData] = useState<TeamData | undefined>(undefined)
  const [sel, setSel] = useState(0)
  const [detail, setDetail] = useState<{ roleId: string; offset: number } | undefined>(undefined)
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined)
  const [message, setMessage] = useState<Message | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>('Loading the team')
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const load = useCallback(async (): Promise<TeamData> => {
    const [project, connections, catalog] = await Promise.all([api.project(projectId), api.connections(), api.models()])
    return { project, connections: Array.isArray(connections) ? connections : [], catalog: Array.isArray(catalog) ? catalog : [] }
  }, [api, projectId])

  useEffect(() => {
    load()
      .then((d) => alive.current && setData(d))
      .catch((e: unknown) => alive.current && setMessage(errorMessage(e)))
      .finally(() => alive.current && setBusy(undefined))
  }, [load])

  const rows = data ? teamRows(data, `${glyphs(env).branch} `, `${glyphs(env).lastBranch} `, `${glyphs(env).v}  `) : []
  const selected = rows[Math.min(sel, Math.max(0, rows.length - 1))]
  const targetId = detail?.roleId ?? selected?.id
  const targetRole = data?.project.roles.find((r) => r.id === targetId)

  /** Runs one step with the busy line up and any error shown in place. */
  const act = (what: string, fn: () => Promise<void>): void => {
    setMessage(undefined)
    setBusy(what)
    fn()
      .catch((e: unknown) => alive.current && setMessage(errorMessage(e)))
      .finally(() => alive.current && setBusy(undefined))
  }

  /** Save a planned chart (after `y` when it may spend more, or always for `question`), then show the saved team. */
  const commit = (fresh: Project, plan: RolePlan, done: string, question?: string): void => {
    const save = (): void =>
      act('Saving', async () => {
        const saved = await api.saveProject({ ...fresh, roles: plan.roles })
        const next = await load().catch(() => ({ ...(data as TeamData), project: saved }))
        if (!alive.current) return
        setData(next)
        const at = teamRows(next).findIndex((r) => r.id === plan.roleId)
        if (at >= 0) setSel(at)
        const notes = plan.notes.map((n) => clean(n, 300))
        setMessage({ text: [done, ...notes, ...(props.liveRun ? [LIVE_RUN_NOTE] : [])].join(' '), tone: 'ok' })
      })
    if (!plan.sentences.length && !question) {
      if (JSON.stringify(plan.roles) === JSON.stringify(fresh.roles)) {
        setMessage({ text: 'Nothing changed.', tone: 'dim' })
        return
      }
      save()
      return
    }
    setDialog({
      kind: 'confirm',
      title: question ? 'Confirm' : 'This change may spend more',
      lines: [...(question ? [question] : []), ...(plan.sentences.length ? [`May spend more: ${plan.sentences.join(' ')}`] : []), '', 'Press y to save, n or Esc to leave it.'],
      onYes: save
    })
  }

  const refuse = (): boolean => {
    if (props.readOnly) {
      setMessage({ text: `Read-only: ${clean(props.readOnly, 200)}`, tone: 'warn' })
      return true
    }
    if (!data || !targetRole) return true
    return false
  }

  /** `team role set <role>` with these edits. */
  const setRole = (edits: RoleEdits, done: (name: string) => string): void => {
    const roleId = targetId
    if (!roleId) return
    act('Checking', async () => {
      const fresh = await api.project(projectId)
      const env2 = modelEnvOf(data!)
      const plan = planRoleSet(fresh, roleId, edits, env2, labelFrom(env2))
      commit(fresh, plan, done(clean(plan.roles.find((r) => r.id === roleId)?.name ?? plan.before.name, 120)))
    })
  }

  const pick = (title: string, options: PickOption[], onPick: (v: string) => void): void => {
    const cur = options.findIndex((o) => o.label.includes('(current)') || o.detail === '(current)')
    setDialog({ kind: 'pick', title, options, sel: Math.max(0, cur), onPick })
  }

  const actions: Record<string, () => void> = {
    m: () => pick(`Model of ${clean(targetRole!.name, 80)}`, modelOptions(data!, targetRole!.id), (v) => setRole({ model: v }, (n) => `Saved ${n}: model ${v}.`)),
    e: () => pick(`Effort of ${clean(targetRole!.name, 80)}`, effortOptions(targetRole), (v) => setRole({ effort: v }, (n) => `Saved ${n}: effort ${v === 'none' ? 'default' : v}.`)),
    s: () =>
      pick(`Staffing of ${clean(targetRole!.name, 80)}`, staffingModeOptions(targetRole), (mode) => {
        if (mode !== 'auto') {
          setRole({ staffing: mode }, (n) => `Saved ${n}: staffing ${mode === 'inherit' ? 'follows the project' : 'always as configured'}.`)
          return
        }
        // Automatic: then its bounds (the lowest tier, the highest effort).
        pick('Lowest tier automatic staffing may pick', minTierOptions(targetRole), (minTier) =>
          pick('Highest effort automatic staffing may pick', maxEffortOptions(targetRole), (maxEffort) => setRole({ staffing: 'auto', minTier, maxEffort }, (n) => `Saved ${n}: automatic staffing.`))
        )
      }),
    t: () =>
      setDialog({
        kind: 'checks',
        title: `Tools of ${clean(targetRole!.name, 80)}`,
        options: TOOL_CATALOG.map((t) => ({ value: t, label: t })),
        checked: [...targetRole!.tools],
        sel: 0,
        onDone: (values) => setRole({ tools: values.length ? values.join(',') : 'none' }, (n) => `Saved ${n}: ${values.length} tool${values.length === 1 ? '' : 's'}.`)
      }),
    r: () => {
      if (targetRole!.reportsTo === null) {
        setMessage({ text: `${clean(targetRole!.name, 80)} is the top of the chart; a chart keeps its top role.`, tone: 'warn' })
        return
      }
      pick(`New manager of ${clean(targetRole!.name, 80)}`, managerOptions(data!.project, targetRole!.id), (to) => {
        const roleId = targetRole!.id
        act('Checking', async () => {
          const fresh = await api.project(projectId)
          const plan = planRoleMove(fresh, roleId, to)
          if (plan.unchanged) {
            setMessage({ text: `${clean(plan.before.name, 80)} already reports to ${clean(plan.manager.name, 80)}.`, tone: 'dim' })
            return
          }
          commit(fresh, plan, `${clean(plan.before.name, 80)} now reports to ${clean(plan.manager.name, 80)}.`)
        })
      })
    },
    n: () =>
      setDialog({
        kind: 'input',
        title: `Rename ${clean(targetRole!.name, 80)}`,
        text: targetRole!.name,
        hint: 'The slug follows the name.',
        onSubmit: (name) => setRole({ name }, (n) => `Renamed to ${n}.`)
      }),
    p: () => {
      const role = targetRole!
      const command = `orgai team role set ${role.slug} --edit`
      if (!props.editText) {
        setMessage({ text: `The editor cannot open from here. Edit the prompt from a shell: ${command}`, tone: 'warn' })
        return
      }
      const edit = props.editText
      act('Editing the prompt', async () => {
        const text = await edit(role.prompt)
        if (text === role.prompt) {
          setMessage({ text: 'Prompt unchanged.', tone: 'dim' })
          return
        }
        if (text.length > PROMPT_MAX_CHARS) throw new Error(`--prompt: the prompt is longer than ${PROMPT_MAX_CHARS} characters.`)
        const fresh = await api.project(projectId)
        const plan = planRoleSet(fresh, role.id, { prompt: text }, modelEnvOf(data!), labelFrom(modelEnvOf(data!)))
        commit(fresh, plan, `Saved the prompt of ${clean(role.name, 80)} (${text.length} characters).`)
      })
    },
    a: () => {
      const manager = targetRole!
      setDialog({
        kind: 'input',
        title: `New role reporting to ${clean(manager.name, 80)}`,
        text: '',
        hint: 'Its name. It starts on the everyday tier with Read, Glob and Grep; edit it after.',
        onSubmit: (name) =>
          act('Checking', async () => {
            if (!name.trim()) throw new Error('Give the new role a name.')
            const fresh = await api.project(projectId)
            const env2 = modelEnvOf(data!)
            const plan = planRoleAdd(fresh, manager.id, { name }, env2, labelFrom(env2))
            commit(fresh, plan, `Added ${clean(plan.base.name, 80)} under ${clean(plan.manager.name, 80)}.`)
          })
      })
    },
    x: () => {
      const gone = targetRole!
      const remove = (reparent?: string): void =>
        act('Checking', async () => {
          const fresh = await api.project(projectId)
          const plan = planRoleRemove(fresh, gone.id, reparent)
          setDetail(undefined)
          commit(fresh, plan, `Removed ${clean(plan.gone.name, 80)}.${plan.moved}`, plan.question)
        })
      const reports = data!.project.roles.filter((r) => r.reportsTo === gone.id)
      if (reports.length && gone.reportsTo !== null) {
        pick(`${reports.length} role${reports.length === 1 ? ' reports' : 's report'} to ${clean(gone.name, 60)}: who takes ${reports.length === 1 ? 'it' : 'them'}?`, managerOptions(data!.project, gone.id).map((o) => ({ ...o, label: o.label.replace(/ \(current\)$/, '') })), (to) => remove(to))
      } else remove()
    }
  }

  const page = Math.max(1, contentSize(props.width, props.height, env, LIST_KEYS, message).bodyRows - 1)

  const onKey = (e: InputEvent): boolean => {
    if (busy) {
      // Only leaving is allowed while a call is out; its answer is then dropped.
      if (keyIs(e, 'escape') || isCtrlC(e)) props.onClose()
      return true
    }
    if (dialog) {
      const { next, then } = dialogKey(dialog, e, page)
      setDialog(next)
      then?.()
      return true
    }
    if (isCtrlC(e)) {
      props.onClose()
      return true
    }
    if (keyIs(e, 'escape')) {
      if (detail) setDetail(undefined)
      else props.onClose()
      return true
    }
    const ch = charOf(e)
    if (detail) {
      const moved = moveSel(e, detail.offset, 10_000, page)
      if (moved !== undefined) {
        setDetail({ ...detail, offset: moved })
        return true
      }
    } else {
      const moved = moveSel(e, sel, rows.length, page)
      if (moved !== undefined) {
        setSel(moved)
        setMessage(undefined)
        return true
      }
      if (keyIs(e, 'enter') && selected) {
        setDetail({ roleId: selected.id, offset: 0 })
        setMessage(undefined)
        return true
      }
    }
    if (ch && actions[ch]) {
      if (!refuse()) actions[ch]()
      return true
    }
    return true
  }
  useFocusHandler('config', onKey)

  const keys = dialog ? dialogKeys(dialog) : detail ? DETAIL_KEYS : LIST_KEYS
  const msg: Message | undefined = busy ? { text: `${busy}...`, tone: 'dim' } : message
  const { width: w, bodyRows } = contentSize(props.width, props.height, env, keys, msg)
  const project = data?.project
  const title = detail && targetRole ? `Team ${separatorFor(env).trim()} ${clean(targetRole.name, 80)}` : `Team${project ? ` of ${clean(project.name, 80)} (${project.roles.length} role${project.roles.length === 1 ? '' : 's'}, saved)` : ''}`
  let body: PaneLine[] = []
  if (dialog) body = dialogLines(dialog, w, bodyRows, env)
  else if (detail && data) {
    const lines = roleDetailLines(data, detail.roleId, w)
    const max = Math.max(0, lines.length - bodyRows)
    const offset = Math.min(detail.offset, max)
    body = lines.slice(offset, offset + bodyRows).map((l, i) => ({ key: `d${offset + i}`, segs: l ? [{ text: truncateEnd(l, w, glyphs(env).ellipsis) }] : [] }))
  } else if (data) {
    if (rows.length === 0) body = [{ key: 'none', segs: [{ text: 'This project has no roles yet.', dim: true }] }]
    else {
      const nameWidth = Math.min(28, Math.max(...rows.map((r) => textWidth(r.prefix) + textWidth(r.name))))
      const win = windowOf(rows, sel, bodyRows)
      body = win.items.map((r, i) => ({ key: r.id, segs: teamRowSegs(r, w, nameWidth, separatorFor(env), glyphs(env).ellipsis, win.start + i === sel) }))
    }
  }
  return <ConfigFrame width={props.width} height={props.height} env={env} title={title} body={body} {...(msg ? { message: msg } : {})} keys={keys} />
}
