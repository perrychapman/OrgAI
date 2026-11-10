/**
 * /settings (cli-parity 3.7): Project, Tiers and App settings, each row with its current value, edited in place with
 * the validators the commands use: `projects set` (setPatch, and its "automatic staffing may spend more" question),
 * `permissions mode` (permissionModeArg), `connections tier` (planTierChange, and the roles the change touches,
 * previewTierChange, shown before `y`) and `orgai settings set` (parseSettingValue). Every save reads afresh first
 * and goes to the host on the channel the command uses. Read-only rows say where they are changed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { projectConnection } from '../../shared/defaults'
import { MODEL_TIERS, PERMISSION_MODE_OPTIONS, isModelTier, type Project } from '../../shared/types'
import { connectionLabel, planTierChange, previewTierChange, tierAffectedLines } from '../commands/connections'
import { permissionModeArg } from '../commands/permissions'
import { setPatch, staffingSpendSentence } from '../commands/projects'
import { parseSettingValue, settingValue, type SettingKey } from '../commands/settings'
import { useFocusHandler } from './context'
import type { TuiConfigApi } from './configApi'
import { charOf, clean, ConfigFrame, contentSize, dialogKey, dialogKeys, dialogLines, errorMessage, isCtrlC, keyIs, moveSel, windowOf, type Dialog, type Message, type PickOption } from './configUi'
import type { PaneLine, Seg } from './panes/lines'
import { textWidth, truncateEnd } from './panes/text'
import { GROUP_TITLES, settingRows, type SettingRow, type SettingsData } from './settingsModel'
import { glyphs } from './theme'
import type { InputEvent, TuiEnv } from './types'

export interface SettingsViewProps {
  width: number
  height: number
  env: TuiEnv
  projectId: string
  api: TuiConfigApi
  readOnly?: string
  /** A run of this project is live: a save says it applies from the next run. */
  liveRun?: boolean
  onClose(): void
}

export const SETTINGS_KEYS = ['Up/Down select', 'Enter edit', 'Esc back']
export const SETTINGS_LIVE_NOTE = 'A live run keeps the settings it started with; this applies from the next run.'
const LABEL_WIDTH = 24

/** One settings row cut to `width`: the description goes first, then the value is cut, the label last. */
export function settingRowSegs(row: SettingRow, width: number, selected: boolean, ellipsis: string): Seg[] {
  const head = `${selected ? '> ' : '  '}`
  const label = clean(row.label, 60)
  const labelCol = textWidth(label) >= LABEL_WIDTH ? `${label} ` : label + ' '.repeat(LABEL_WIDTH - textWidth(label))
  const ro = row.readOnly ? ' (read-only)' : ''
  const left = textWidth(head) + textWidth(labelCol)
  const valueRoom = Math.max(4, width - left - textWidth(ro))
  const value = truncateEnd(row.value, valueRoom, ellipsis)
  const segs: Seg[] = [
    { text: head, ...(selected ? { tone: 'accent' as const, bold: true } : {}) },
    { text: labelCol, ...(selected ? { bold: true } : {}) },
    { text: value, ...(row.readOnly ? { dim: true } : {}) }
  ]
  if (ro) segs.push({ text: ro, dim: true })
  const used = left + textWidth(value) + textWidth(ro)
  const detail = row.detail ? clean(row.detail, 200) : ''
  if (detail && width - used - 2 >= 8) segs.push({ text: `  ${truncateEnd(detail, width - used - 2, ellipsis)}`, dim: true })
  return segs
}

export function SettingsView(props: SettingsViewProps) {
  const { env, api, projectId } = props
  const [data, setData] = useState<SettingsData | undefined>(undefined)
  const [sel, setSel] = useState(0)
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined)
  const [message, setMessage] = useState<Message | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>('Loading the settings')
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const load = useCallback(async (): Promise<SettingsData> => {
    const [project, connections, catalog, settings] = await Promise.all([api.project(projectId), api.connections(), api.models(), api.settings()])
    return { project, connections: Array.isArray(connections) ? connections : [], catalog: Array.isArray(catalog) ? catalog : [], settings: settings && typeof settings === 'object' ? settings : {} }
  }, [api, projectId])

  useEffect(() => {
    load()
      .then((d) => alive.current && setData(d))
      .catch((e: unknown) => alive.current && setMessage(errorMessage(e)))
      .finally(() => alive.current && setBusy(undefined))
  }, [load])

  const rows = data ? settingRows(data) : []
  const row = rows[Math.min(sel, Math.max(0, rows.length - 1))]

  const act = (what: string, fn: () => Promise<void>): void => {
    setMessage(undefined)
    setBusy(what)
    fn()
      .catch((e: unknown) => alive.current && setMessage(errorMessage(e)))
      .finally(() => alive.current && setBusy(undefined))
  }
  const saved = async (text: string, live: boolean): Promise<void> => {
    const next = await load()
    if (!alive.current) return
    setData(next)
    setMessage({ text: [text, ...(live && props.liveRun ? [SETTINGS_LIVE_NOTE] : [])].join(' '), tone: 'ok' })
  }
  const confirm = (title: string, lines: string[], onYes: () => void): void => setDialog({ kind: 'confirm', title, lines: [...lines, '', 'Press y to save, n or Esc to leave it.'], onYes })

  /** `projects set --<flag> <raw>`: setPatch validates, automatic staffing asks first, projects:save stores. */
  const setProject = (flag: string, raw: string, label: string): void =>
    act('Checking', async () => {
      const fresh = await api.project(projectId)
      const patch = setPatch(fresh, { [flag]: raw })
      const save = (): void =>
        act('Saving', async () => {
          await api.saveProject({ ...fresh, ...patch } as Project)
          await saved(`Saved ${label}.`, true)
        })
      const spend = staffingSpendSentence(fresh, patch)
      if (spend) confirm('This change may spend more', [`May spend more: ${spend}`, `Switch ${clean(fresh.name, 80)} to automatic staffing?`], save)
      else save()
    })

  const pick = (title: string, options: PickOption[], current: string, onPick: (v: string) => void): void =>
    setDialog({ kind: 'pick', title, options: options.map((o) => (o.value === current ? { ...o, label: `${o.label} (current)` } : o)), sel: Math.max(0, options.findIndex((o) => o.value === current)), onPick })

  const editTier = (tier: (typeof MODEL_TIERS)[number]): void => {
    const d = data!
    const id = projectConnection(d.project)
    const info = d.connections.find((i) => i.connection.id === id)
    if (!info) return
    const catalog = d.catalog.filter((m) => m.connection === id)
    const current = info.connection.tierModels[tier] ?? ''
    const options: PickOption[] = [
      ...catalog.map((m) => ({ value: m.id, label: clean(m.id, 120), detail: [m.label && m.label !== m.id ? clean(m.label, 60) : '', m.source ?? ''].filter(Boolean).join(', ') })),
      { value: '\u0000reset', label: "reset to discovery's choice" }
    ]
    pick(`${tier} on ${clean(connectionLabel(info.connection), 60)}`, options, current, (value) =>
      act('Checking', async () => {
        const conns = await api.connections()
        const fresh = (Array.isArray(conns) ? conns : []).find((i) => i.connection.id === id)
        if (!fresh) throw new Error(`The host did not list ${id}.`)
        const label = connectionLabel(fresh.connection)
        const reset = value === '\u0000reset'
        const plan = planTierChange(fresh.connection, label, catalog, reset ? {} : { [tier]: value }, reset ? [tier] : [], false)
        if (!plan.changed.length) {
          setMessage({ text: [`${label}: no tier changes.`, ...plan.notes].join(' '), tone: 'dim' })
          return
        }
        const projects = await api.projects()
        const affected = previewTierChange(Array.isArray(projects) ? projects : [], id, plan, catalog)
        confirm(`Change ${label} tiers`, [...plan.changeLines.map((l) => l.trim()), ...tierAffectedLines(affected, true), ...plan.notes], () =>
          act('Saving', async () => {
            await api.updateConnection({ ...fresh.connection, tierModels: plan.next })
            await saved(`${label}: tiers saved (${plan.changed.join(', ')}).`, true)
          })
        )
      })
    )
  }

  const editApp = (spec: SettingKey): void => {
    const d = data!
    const raw = settingValue(d.settings, spec)
    const apply = (text: string): void =>
      act('Saving', async () => {
        const value = parseSettingValue(spec, text, new Set(d.catalog.map((m) => m.id)))
        await api.setSetting({ [spec.key]: value })
        await saved(`Saved ${spec.key}.`, false)
      })
    switch (spec.kind) {
      case 'boolean':
        apply(raw === true ? 'off' : 'on')
        return
      case 'enum':
        pick(spec.key, (spec.values ?? []).map((v) => ({ value: v, label: v })), String(raw ?? ''), apply)
        return
      case 'model': {
        const ids = [...new Set(d.catalog.map((m) => m.id))]
        pick(spec.key, [...MODEL_TIERS.map((t) => ({ value: t, label: t, detail: 'a tier' })), ...ids.map((id) => ({ value: id, label: clean(id, 120) }))], String(raw ?? ''), apply)
        return
      }
      default:
        setDialog({ kind: 'input', title: spec.key, text: raw === null ? '' : String(raw), hint: `${spec.description}.${spec.clearable ? ' none clears it.' : ''}`, onSubmit: apply })
    }
  }

  const edit = (r: SettingRow): void => {
    if (r.readOnly || !r.edit) {
      setMessage({ text: `${clean(r.label, 60)} is read-only here. ${clean(r.readOnly ?? '', 200)}`.trim(), tone: 'warn' })
      return
    }
    if (props.readOnly) {
      setMessage({ text: `Read-only: ${clean(props.readOnly, 200)}`, tone: 'warn' })
      return
    }
    const e = r.edit
    switch (e.kind) {
      case 'project':
        if (e.input === 'onoff') setProject(e.flag, r.value === 'on' ? 'off' : 'on', r.label.toLowerCase())
        else if (e.input === 'enum') pick(r.label, e.values.map((v) => ({ value: v, label: v })), r.value, (v) => setProject(e.flag, v, r.label.toLowerCase()))
        else setDialog({ kind: 'input', title: r.label, text: e.raw, hint: e.hint, onSubmit: (text) => setProject(e.flag, text, r.label.toLowerCase()) })
        return
      case 'permissionMode':
        pick(
          'Permission mode',
          PERMISSION_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.value, detail: o.label })),
          r.value,
          (v) =>
            act('Saving', async () => {
              const mode = permissionModeArg(v)
              const fresh = await api.project(projectId)
              await api.saveProject({ ...fresh, permissionMode: mode })
              await saved(`Saved permission mode ${mode}.`, true)
            })
        )
        return
      case 'tier':
        if (isModelTier(e.tier)) editTier(e.tier)
        return
      case 'app':
        editApp(e.spec)
        return
    }
  }

  const page = Math.max(1, contentSize(props.width, props.height, env, SETTINGS_KEYS, message).bodyRows - 2)
  const onKey = (e: InputEvent): boolean => {
    if (busy) {
      if (keyIs(e, 'escape') || isCtrlC(e)) props.onClose()
      return true
    }
    if (dialog) {
      const { next, then } = dialogKey(dialog, e, page)
      setDialog(next)
      then?.()
      return true
    }
    if (keyIs(e, 'escape') || isCtrlC(e)) {
      props.onClose()
      return true
    }
    const moved = moveSel(e, sel, rows.length, page)
    if (moved !== undefined) {
      setSel(moved)
      setMessage(undefined)
      return true
    }
    if ((keyIs(e, 'enter') || charOf(e) === ' ') && row) edit(row)
    return true
  }
  useFocusHandler('config', onKey)

  const keys = dialog ? dialogKeys(dialog) : SETTINGS_KEYS
  const msg: Message | undefined = busy ? { text: `${busy}...`, tone: 'dim' } : message
  const { width: w, bodyRows } = contentSize(props.width, props.height, env, keys, msg)
  const title = `Settings${data ? ` of ${clean(data.project.name, 80)}` : ''}`
  let body: PaneLine[] = []
  if (dialog) body = dialogLines(dialog, w, bodyRows, env)
  else if (data) {
    // Group headings between the rows; the window keeps the selected row (and its heading when there is room) in view.
    const lines: { line: PaneLine; row?: number }[] = []
    rows.forEach((r, i) => {
      if (i === 0 || rows[i - 1].group !== r.group) {
        if (i > 0) lines.push({ line: { key: `gap-${r.group}`, segs: [] } })
        lines.push({ line: { key: `g-${r.group}`, segs: [{ text: GROUP_TITLES[r.group], bold: true, tone: 'accent' }] } })
      }
      lines.push({ line: { key: r.id, segs: settingRowSegs(r, w, i === sel, glyphs(env).ellipsis) }, row: i })
    })
    const at = lines.findIndex((l) => l.row === sel)
    const win = windowOf(lines, at, bodyRows)
    body = win.items.map((l) => l.line)
  }
  return <ConfigFrame width={props.width} height={props.height} env={env} title={title} body={body} {...(msg ? { message: msg } : {})} keys={keys} />
}
