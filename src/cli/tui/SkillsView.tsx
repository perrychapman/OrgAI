/**
 * /skills: the project's skills. Enter opens a skill's details and reads its text in the background; the letter keys
 * edit the selected (or detailed) skill. Every edit is ONE field of ONE skill through the host's skills:* channels
 * (toolsApi.ts): `updateSkill` sends the skill afresh with that one field changed (its role ids are the COMPLETE set of
 * roles that hold it afterwards), `linkSkill` adds a library entry for the roles ticked, `removeSkill` drops the skill
 * from this project. After a save the view reloads the list, keeps the selection on the same skill and drops the text
 * it cached for that skill (it may have changed). A skill whose text could not be read says so in its own details,
 * and a read a newer read for the same skill has overtaken is dropped. The other errors show in place.
 *
 * The host lets a project be saved while a run is live. A work run this terminal hosts takes the save itself and says
 * so in the status line (liveChangeText.ts); any other live run keeps the skills it started with, and only then the view
 * adds SKILLS_LIVE_NOTE (`liveRun`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkillContent, SkillInfo, SkillMutationResult } from '../../shared/types'
import { useFocusHandler } from './context'
import { charOf, clean, ConfigFrame, confirmFits, contentSize, dialogKey, dialogKeys, dialogLines, errorMessage, isCtrlC, keyIs, moveSel, windowOf, type Dialog, type Message } from './configUi'
import { grantedInProject, skillConfirmLines, skillDetailLines, skillWidens, skillLibraryOptions, skillRoleOptions, skillRowSegs, skillRows, type SkillsData } from './skillsModel'
import type { PaneLine } from './panes/lines'
import { textWidth, truncateEnd } from './panes/text'
import { glyphs, separatorFor } from './theme'
import type { TuiToolsApi } from './toolsApi'
import type { InputEvent, TuiEnv } from './types'

export interface SkillsViewProps {
  width: number
  height: number
  env: TuiEnv
  projectId: string
  api: TuiToolsApi
  /** Set when this session is read-only: the view shows, edits are refused with this reason. */
  readOnly?: string
  /** A live run of this project does not take a save itself (liveChangeText.ts takesSavedTeam): a save adds SKILLS_LIVE_NOTE. */
  liveRun?: boolean
  onClose(): void
}

export const SKILLS_LIVE_NOTE = 'A live run without a team, or in another terminal, keeps the skills it started with; this applies from its next run.'

export const SKILLS_LIST_KEYS = ['Up/Down select', 'Enter details', 'Space on/off', 'r roles', 'l add from library', 'x remove', 'Esc back']
export const SKILLS_DETAIL_KEYS = ['Up/Down scroll', 'Space on/off', 'r roles', 'x remove', 'Esc back']

/** The same set of role ids (order aside). */
const sameRoles = (before: string[], after: string[]): boolean => [...before].sort().join('\u0000') === [...after].sort().join('\u0000')

export function SkillsView(props: SkillsViewProps) {
  const { env, api, projectId } = props
  const [data, setData] = useState<SkillsData | undefined>(undefined)
  const [sel, setSel] = useState(0)
  const [detail, setDetail] = useState<{ skillId: string; offset: number } | undefined>(undefined)
  /** The skill text skills:read gave, by skill id; a skill missing from it has no text yet. */
  const [texts, setTexts] = useState<Record<string, SkillContent>>({})
  /** The skills whose last skills:read failed, by skill id; their details say the text could not be read. */
  const [failed, setFailed] = useState<Record<string, boolean>>({})
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined)
  const [message, setMessage] = useState<Message | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>('Loading the skills')
  const alive = useRef(true)
  /** How often each skill's text has been read; an answer of a read that a newer one overtook is dropped. */
  const reads = useRef<Record<string, number>>({})
  useEffect(() => () => void (alive.current = false), [])

  const load = useCallback(async (): Promise<SkillsData> => {
    const [project, skills] = await Promise.all([api.project(projectId), api.skills(projectId)])
    return { project, skills: Array.isArray(skills) ? skills : [] }
  }, [api, projectId])

  useEffect(() => {
    load()
      .then((d) => alive.current && setData(d))
      .catch((e: unknown) => alive.current && setMessage(errorMessage(e)))
      .finally(() => alive.current && setBusy(undefined))
  }, [load])

  const rows = data ? skillRows(data) : []
  // The one clamped index: the highlight and every action read the same row after the list shrinks.
  const selIdx = Math.min(sel, Math.max(0, rows.length - 1))
  const selected = rows[selIdx]
  const targetId = detail?.skillId ?? selected?.id
  const target = data?.skills.find((s) => s.spec.id === targetId)

  /** Runs one step with the busy line up and any error shown in place. */
  const act = (what: string, fn: () => Promise<void>): void => {
    setMessage(undefined)
    setBusy(what)
    fn()
      .catch((e: unknown) => alive.current && setMessage(errorMessage(e)))
      .finally(() => alive.current && setBusy(undefined))
  }

  /**
   * skills:read, out of the way of the view: the details show `Loading the text...` until it arrives, and
   * `The text could not be read.` when it failed (the details say so; the status line does not). A read that a newer
   * read of the same skill has overtaken is dropped whole, so a late answer cannot cache the text as it was before a
   * save.
   */
  const readText = (skillId: string): void => {
    const seq = (reads.current[skillId] ?? 0) + 1
    reads.current[skillId] = seq
    // A read is out again: the details load until it answers.
    setFailed((prev) => (prev[skillId] ? { ...prev, [skillId]: false } : prev))
    api
      .readSkill(projectId, skillId)
      .then((content) => {
        if (!alive.current || !content || reads.current[skillId] !== seq) return
        setTexts((prev) => ({ ...prev, [skillId]: content }))
      })
      .catch(() => {
        if (alive.current && reads.current[skillId] === seq) setFailed((prev) => ({ ...prev, [skillId]: true }))
      })
  }

  /**
   * One save (`skills:update` / `skills:linkLibrary` / `skills:remove`), then the saved list with the selection kept on
   * the skill `keep` names (a function reads it from the refreshed data, e.g. the id a link got), or on the last row
   * there is when that skill is no longer in the list. The cached text of the skill `dropped` names is forgotten, and
   * re-read when its details are open.
   */
  const save = (fn: () => Promise<SkillMutationResult>, keep: string | undefined | ((next: SkillsData) => string | undefined), done: string, dropped?: string): void => {
    act('Saving', async () => {
      const res = await fn()
      const next = await load().catch(() => ({ project: res.project, skills: res.skills }))
      if (!alive.current) return
      setData(next)
      const drop = dropped
      if (drop !== undefined) {
        setTexts((prev) => {
          const copy = { ...prev }
          delete copy[drop]
          return copy
        })
        if (detail?.skillId === drop) readText(drop)
      }
      const id = typeof keep === 'function' ? keep(next) : keep
      const rowsOfNext = skillRows(next)
      const at = rowsOfNext.findIndex((r) => r.id === id)
      // The skill kept is gone (its own removal): fall back to the last row there is, so one stays highlighted.
      if (at >= 0) setSel(at)
      else setSel((s) => Math.min(s, Math.max(0, rowsOfNext.length - 1)))
      setMessage({ text: [done, ...(props.liveRun ? [SKILLS_LIVE_NOTE] : [])].join(' '), tone: 'ok' })
    })
  }

  /** `needsSkill` false: the action works on the project (add from the library), so an empty list does not stop it. */
  const refuse = (needsSkill = true): boolean => {
    if (props.readOnly) {
      setMessage({ text: `Read-only: ${clean(props.readOnly, 200)}`, tone: 'warn' })
      return true
    }
    if (!data || (needsSkill && !target)) return true
    return false
  }

  /** The names of the roles of `ids` in this project, or "no role". */
  const roleNames = (ids: string[]): string => {
    const names = data!.project.roles.filter((r) => ids.includes(r.id)).map((r) => clean(r.name, 80))
    return names.length ? names.join(', ') : 'no role'
  }

  /**
   * A widening save asks first: what the skill is, then y (any other key cancels, nothing is saved). The dialog does not
   * scroll, so a text that does not fit whole is refused instead of cut.
   */
  const confirmWidening = (lines: string[], run: () => void): void => {
    const { width: cw, bodyRows: cr } = contentSize(props.width, props.height, env, dialogKeys({ kind: 'confirm', strict: true, title: '', lines: [], onYes: () => undefined }))
    if (!confirmFits(lines, cw, cr)) {
      setMessage({ text: 'This skill is too long to show whole in this window, so it was not saved. Make the window larger, or use the orgai skills command.', tone: 'warn' })
      return
    }
    setMessage(undefined)
    setDialog({ kind: 'confirm', strict: true, title: 'Confirm', lines, onYes: run })
  }

  /** The confirmation for a skill of this project: reads SKILL.md first (the cached text, else a read), and says so when it cannot. */
  const confirmProjectSkill = (info: SkillInfo, headline: string, grantedTo: string, run: () => void): void => {
    const cached = texts[info.spec.id]
    if (cached) {
      confirmWidening(skillConfirmLines(info.spec, headline, grantedTo, cached), run)
      return
    }
    act('Reading the skill', async () => {
      let content: SkillContent | 'failed'
      try {
        content = (await api.readSkill(projectId, info.spec.id)) ?? 'failed'
      } catch {
        content = 'failed'
      }
      if (!alive.current) return
      confirmWidening(skillConfirmLines(info.spec, headline, grantedTo, content), run)
    })
  }

  /** Space: this skill reaches runs or it does not. Turning one on asks first. */
  const toggle = (): void => {
    const info = target!
    const on = !info.spec.enabled
    const name = clean(info.spec.name, 80)
    const project = data!.project
    const hint = on && !grantedInProject(project, info.grantedTo).length ? ' No role holds it yet: press r.' : ''
    const run = (): void => save(() => api.updateSkill(projectId, info.spec.id, { enabled: on }), info.spec.id, `Turned ${name} ${on ? 'on' : 'off'}.${hint}`, info.spec.id)
    if (skillWidens(project, { enabled: info.spec.enabled, roleIds: info.grantedTo }, { enabled: on, roleIds: info.grantedTo })) {
      confirmProjectSkill(info, `Turn ${name} on?`, roleNames(info.grantedTo), run)
      return
    }
    run()
  }

  /** r: which roles may load this skill (role ids; the set saved replaces the one the skill had). */
  const editRoles = (): void => {
    const info = target!
    const project = data!.project
    const before = grantedInProject(project, info.grantedTo)
    setDialog({
      kind: 'checks',
      title: `Roles that may load ${clean(info.spec.name, 80)}`,
      options: skillRoleOptions(project),
      checked: before,
      sel: 0,
      onDone: (values) => {
        const next = grantedInProject(project, values)
        if (sameRoles(before, next)) {
          setMessage({ text: 'Nothing changed.', tone: 'dim' })
          return
        }
        const names = project.roles.filter((r) => next.includes(r.id)).map((r) => clean(r.name, 80))
        const run = (): void => save(() => api.updateSkill(projectId, info.spec.id, { roleIds: next }), info.spec.id, `${clean(info.spec.name, 80)} is now granted to ${names.length ? names.join(', ') : 'no role'}.`, info.spec.id)
        if (skillWidens(project, { enabled: info.spec.enabled, roleIds: before }, { enabled: info.spec.enabled, roleIds: next })) {
          confirmProjectSkill(info, `Let ${names.join(', ')} load ${clean(info.spec.name, 80)}?`, names.join(', '), run)
          return
        }
        run()
      }
    })
  }

  /** l: add one of your library's skills to this project, for the roles ticked. */
  const addFromLibrary = (): void => {
    const skills = data!.skills
    const project = data!.project
    act('Loading your library', async () => {
      const library = await api.skillLibrary()
      const options = skillLibraryOptions(Array.isArray(library) ? library : [], skills)
      if (!options.length) {
        setMessage({ text: 'Your library has no other skill to add. Add one with: orgai skills library create', tone: 'dim' })
        return
      }
      setDialog({
        kind: 'pick',
        title: 'Add a skill from your library',
        options,
        sel: 0,
        onPick: (libraryId) => {
          const label = options.find((o) => o.value === libraryId)?.label ?? 'that skill'
          setDialog({
            kind: 'checks',
            title: `Roles that may load ${label}`,
            options: skillRoleOptions(project),
            checked: [],
            sel: 0,
            onDone: (values) => {
              const ids = grantedInProject(project, values)
              const done = ids.length ? `Added ${label} for ${ids.length} role${ids.length === 1 ? '' : 's'}.` : `Added ${label}. No role holds it yet: press r.`
              const run = (): void => save(() => api.linkSkill(projectId, libraryId, ids), (next) => next.skills.find((s) => s.spec.libraryId === libraryId)?.spec.id, done)
              const entry = (Array.isArray(library) ? library : []).find((i) => i.entry.id === libraryId)?.entry
              if (!entry) {
                setMessage({ text: 'That library entry could not be read, so it was not added.', tone: 'warn' })
                return
              }
              const names = project.roles.filter((r) => ids.includes(r.id)).map((r) => clean(r.name, 80))
              confirmWidening(skillConfirmLines(entry, `Add ${label} from your library?`, names.length ? names.join(', ') : 'no role', 'unread', libraryId), run)
            }
          })
        }
      })
    })
  }

  /** x: take this skill out of this project (a linked skill keeps its library entry). */
  const remove = (): void => {
    const info = target!
    const name = clean(info.spec.name, 80)
    const ids = grantedInProject(data!.project, info.grantedTo)
    const held = data!.project.roles.filter((r) => ids.includes(r.id)).map((r) => clean(r.name, 80))
    setDialog({
      kind: 'confirm',
      title: 'Confirm',
      lines: [`Remove ${name} from this project?`, ...(held.length ? [`These roles lose it: ${held.join(', ')}.`] : []), '', 'Press y to remove, n or Esc to keep it.'],
      onYes: () => {
        setDetail(undefined)
        save(() => api.removeSkill(projectId, info.spec.id), undefined, `Removed ${name}.`, info.spec.id)
      }
    })
  }

  const actions: Record<string, () => void> = { ' ': toggle, r: editRoles, l: addFromLibrary, x: remove }

  const page = Math.max(1, contentSize(props.width, props.height, env, SKILLS_LIST_KEYS, message).bodyRows - 1)

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
      const moved = moveSel(e, selIdx, rows.length, page)
      if (moved !== undefined) {
        setSel(moved)
        setMessage(undefined)
        return true
      }
      if (keyIs(e, 'enter') && selected) {
        setDetail({ skillId: selected.id, offset: 0 })
        setMessage(undefined)
        readText(selected.id)
        return true
      }
    }
    if (ch && actions[ch]) {
      // The library is only added from the list.
      if (!refuse(ch !== 'l') && !(detail && ch === 'l')) actions[ch]()
      return true
    }
    return true
  }
  useFocusHandler('config', onKey)

  const keys = dialog ? dialogKeys(dialog) : detail ? SKILLS_DETAIL_KEYS : SKILLS_LIST_KEYS
  const msg: Message | undefined = busy ? { text: `${busy}...`, tone: 'dim' } : message
  const { width: w, bodyRows } = contentSize(props.width, props.height, env, keys, msg)
  const title = detail && target ? `Skill ${separatorFor(env).trim()} ${clean(target.spec.name, 80)}` : `Skills${data ? ` of ${clean(data.project.name, 80)} (${data.skills.length} skill${data.skills.length === 1 ? '' : 's'})` : ''}`
  let body: PaneLine[] = []
  if (dialog) body = dialogLines(dialog, w, bodyRows, env)
  else if (detail && data) {
    const lines = skillDetailLines(data, detail.skillId, failed[detail.skillId] ? 'failed' : texts[detail.skillId])
    const max = Math.max(0, lines.length - bodyRows)
    const offset = Math.min(detail.offset, max)
    body = lines.slice(offset, offset + bodyRows).map((l, i) => ({ key: `d${offset + i}`, segs: l ? [{ text: truncateEnd(l, w, glyphs(env).ellipsis) }] : [] }))
  } else if (data) {
    if (rows.length === 0) body = [{ key: 'none', segs: [{ text: truncateEnd('This project has no skills. Press l to add one from your library, or run: orgai skills create', w, glyphs(env).ellipsis), dim: true }] }]
    else {
      const nameWidth = Math.min(28, Math.max(...rows.map((r) => textWidth(r.name))))
      const win = windowOf(rows, selIdx, bodyRows)
      body = win.items.map((r, i) => ({ key: r.id, segs: skillRowSegs(r, w, nameWidth, separatorFor(env), glyphs(env).ellipsis, win.start + i === selIdx) }))
    }
  }
  return <ConfigFrame width={props.width} height={props.height} env={env} title={title} body={body} {...(msg ? { message: msg } : {})} keys={keys} />
}
