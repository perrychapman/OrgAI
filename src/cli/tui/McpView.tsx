/**
 * /mcp: the project's MCP servers. Enter opens a server's details; the letter keys edit the selected
 * (or detailed) server. Every edit is ONE field of ONE server through the host's mcp:* channels (toolsApi.ts):
 * `setMcp` reads the server afresh and sends the spec with that one field changed, `linkMcp` adds a library entry for
 * every role, `removeMcp` drops it from this project, and `setMcpSecret` / `setMcpLibrarySecret` set (or delete) one
 * secret value, which is typed once and never read back or shown. After a save the view reloads the list and keeps the
 * selection on the same server. Errors show in place.
 *
 * The host lets a project be saved while a run is live. A work run this terminal hosts takes the save itself and says
 * so in the status line (liveChangeText.ts); any other live run keeps the servers it started with, and only then the
 * view adds MCP_LIVE_NOTE (`liveRun`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpMutationResult } from '../../shared/types'
import { useFocusHandler } from './context'
import { charOf, clean, ConfigFrame, contentSize, dialogKey, dialogKeys, dialogLines, errorMessage, isCtrlC, keyIs, moveSel, windowOf, type Dialog, type Message } from './configUi'
import { checkedFromRoles, libraryOptions, mcpDetailLines, mcpRoleOptions, mcpRowSegs, mcpRows, mcpSecretScope, mcpSecretSlots, rolesFromChecks, type McpData, type McpSecretSlot } from './mcpModel'
import type { PaneLine } from './panes/lines'
import { textWidth, truncateEnd } from './panes/text'
import { glyphs, separatorFor } from './theme'
import type { TuiToolsApi } from './toolsApi'
import type { InputEvent, TuiEnv } from './types'

export interface McpViewProps {
  width: number
  height: number
  env: TuiEnv
  projectId: string
  api: TuiToolsApi
  /** Set when this session is read-only: the view shows, edits are refused with this reason. */
  readOnly?: string
  /** A live run of this project does not take a save itself (liveChangeText.ts takesSavedTeam): a save adds MCP_LIVE_NOTE. */
  liveRun?: boolean
  onClose(): void
}

export const MCP_LIVE_NOTE = 'A live run without a team, or in another terminal, keeps the servers it started with; this applies from its next run.'

export const MCP_LIST_KEYS = ['Up/Down select', 'Enter details', 'Space on/off', 'r roles', 's secret', 'l add from library', 'x remove', 'Esc back']
export const MCP_DETAIL_KEYS = ['Up/Down scroll', 'Space on/off', 'r roles', 's secret', 'x remove', 'Esc back']

/** The same set of role slugs (order aside). */
const sameRoles = (before: string[], after: string[]): boolean => [...before].sort().join('\u0000') === [...after].sort().join('\u0000')

export function McpView(props: McpViewProps) {
  const { env, api, projectId } = props
  const [data, setData] = useState<McpData | undefined>(undefined)
  const [sel, setSel] = useState(0)
  const [detail, setDetail] = useState<{ serverId: string; offset: number } | undefined>(undefined)
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined)
  const [message, setMessage] = useState<Message | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>('Loading the MCP servers')
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const load = useCallback(async (): Promise<McpData> => {
    const [project, servers] = await Promise.all([api.project(projectId), api.mcpServers(projectId)])
    return { project, servers: Array.isArray(servers) ? servers : [] }
  }, [api, projectId])

  useEffect(() => {
    load()
      .then((d) => alive.current && setData(d))
      .catch((e: unknown) => alive.current && setMessage(errorMessage(e)))
      .finally(() => alive.current && setBusy(undefined))
  }, [load])

  const rows = data ? mcpRows(data) : []
  const selected = rows[Math.min(sel, Math.max(0, rows.length - 1))]
  const targetId = detail?.serverId ?? selected?.id
  const target = data?.servers.find((s) => s.spec.id === targetId)

  /** Runs one step with the busy line up and any error shown in place. */
  const act = (what: string, fn: () => Promise<void>): void => {
    setMessage(undefined)
    setBusy(what)
    fn()
      .catch((e: unknown) => alive.current && setMessage(errorMessage(e)))
      .finally(() => alive.current && setBusy(undefined))
  }

  /**
   * One save (`mcp:upsert` / `mcp:linkLibrary` / `mcp:remove`), then the saved list with the selection kept on the
   * server `keep` names (a function reads it from the refreshed data, e.g. the id a link got); when that server is no
   * longer in the list the selection falls back to the last row there is. `liveNote` false leaves MCP_LIVE_NOTE out of
   * the message (it is about on/off and roles, not about a secret value).
   */
  const save = (fn: () => Promise<McpMutationResult>, keep: string | undefined | ((next: McpData) => string | undefined), done: string, liveNote = true): void => {
    act('Saving', async () => {
      const res = await fn()
      const next = await load().catch(() => ({ project: res.project, servers: res.servers }))
      if (!alive.current) return
      setData(next)
      const id = typeof keep === 'function' ? keep(next) : keep
      const rowsOfNext = mcpRows(next)
      const at = rowsOfNext.findIndex((r) => r.id === id)
      // The server kept is gone (its own removal): fall back to the last row there is, so one stays highlighted.
      if (at >= 0) setSel(at)
      else setSel((s) => Math.min(s, Math.max(0, rowsOfNext.length - 1)))
      setMessage({ text: [done, ...(props.liveRun && liveNote ? [MCP_LIVE_NOTE] : [])].join(' '), tone: 'ok' })
    })
  }

  /** `needsServer` false: the action works on the project (add from the library), so an empty list does not stop it. */
  const refuse = (needsServer = true): boolean => {
    if (props.readOnly) {
      setMessage({ text: `Read-only: ${clean(props.readOnly, 200)}`, tone: 'warn' })
      return true
    }
    if (!data || (needsServer && !target)) return true
    return false
  }

  /** Space: `orgai mcp enable` / `orgai mcp disable` for this server. */
  const toggle = (): void => {
    const info = target!
    const on = !info.spec.enabled
    const name = clean(info.spec.name, 80)
    const secret = on && info.missingSecrets.length ? ' It cannot start until its secrets are set: orgai mcp set-secret' : ''
    save(() => api.setMcp(projectId, info.spec.id, { enabled: on }), info.spec.id, `Turned ${name} ${on ? 'on' : 'off'}.${secret}`)
  }

  /** r: which roles may use this server (role slugs; every role = no list on the spec). */
  const editRoles = (): void => {
    const info = target!
    const project = data!.project
    // The ticks the dialog opened with: saving exactly those changes nothing, whatever list the spec holds (a list of
    // every role, or one naming a slug this project no longer has, is still the same set of ticks).
    const before = checkedFromRoles(project, info.spec.roles)
    setDialog({
      kind: 'checks',
      title: `Roles that may use ${clean(info.spec.name, 80)}`,
      options: mcpRoleOptions(project),
      checked: before,
      sel: 0,
      onDone: (values) => {
        if (sameRoles(before, values)) {
          setMessage({ text: 'Nothing changed.', tone: 'dim' })
          return
        }
        const next = rolesFromChecks(project, values)
        const to = next === undefined ? 'every role' : next.length === 0 ? 'no role' : `${next.length} role${next.length === 1 ? '' : 's'}`
        save(() => api.setMcp(projectId, info.spec.id, { roles: next }), info.spec.id, `${clean(info.spec.name, 80)} is now available to ${to}.`)
      }
    })
  }

  /**
   * s: set one secret value of this server, or delete it (empty text, and only after a confirm asks). The value is
   * typed once and never shown again, in the frame or in the message. A server with several secrets asks
   * which one first. When the values live in the library entry the server links, the save goes to that entry and every
   * project that links it gets it.
   */
  const editSecret = (): void => {
    const info = target!
    const name = clean(info.spec.name, 80)
    const slots = mcpSecretSlots(info)
    if (slots.length === 0) {
      setMessage({ text: `${name} takes no secret.`, tone: 'dim' })
      return
    }
    const library = mcpSecretScope(info) === 'library'
    const libraryId = info.spec.libraryId ?? ''
    const ask = (slot: McpSecretSlot): void => {
      const secret = clean(slot.name, 80)
      /** One call: `value` null deletes the stored value, anything else replaces it. */
      const apply = (value: string | null): void => {
        const done = `${value === null ? 'Deleted' : 'Saved'} ${secret} ${value === null ? 'of' : 'for'} ${name}. A run that is live now may not use it until its next run.`
        if (!library) {
          save(() => api.setMcpSecret(projectId, info.spec.id, slot.kind, slot.name, value), info.spec.id, done, false)
          return
        }
        // The library save answers with the library, not the project: reload the list the same way `save` does.
        act('Saving', async () => {
          await api.setMcpLibrarySecret(libraryId, slot.kind, slot.name, value)
          const next = await load().catch(() => undefined)
          if (!alive.current) return
          // The value is saved even when the list cannot be read again: say so either way.
          if (next) {
            setData(next)
            const at = mcpRows(next).findIndex((r) => r.id === info.spec.id)
            if (at >= 0) setSel(at)
          }
          setMessage({ text: done, tone: 'ok' })
        })
      }
      setDialog({
        kind: 'input',
        secret: true,
        title: `Value of ${secret} for ${name}`,
        text: '',
        hint: `Typed text is hidden. Enter saves it, Esc cancels. Leave it empty to delete the stored value (it asks first).${library ? ' It belongs to your library entry: every project that links it uses it.' : ''}`,
        onSubmit: (typed) => {
          if (typed !== '') {
            apply(typed)
            return
          }
          // Nothing to delete on a slot that has no value: say so and save nothing.
          if (!slot.set) {
            setMessage({ text: 'Nothing typed: nothing saved.', tone: 'dim' })
            return
          }
          // A stored value is dropped only after a second ask: one stray Enter must not wipe a working secret (for a
          // library entry, in every project that links it). `dialogKey` runs this after the dialog is set, so the
          // confirm replaces the input the same way the library pick opens its second dialog.
          setDialog({
            kind: 'confirm',
            title: 'Confirm',
            lines: [`Delete the stored value of ${secret} for ${name}?`, ...(library ? ['Every project that links this library entry loses it.'] : []), '', 'Press y to delete, n or Esc to keep it.'],
            onYes: () => apply(null)
          })
        }
      })
    }
    if (slots.length === 1) {
      ask(slots[0])
      return
    }
    setDialog({
      kind: 'pick',
      title: `Which secret of ${name}?`,
      options: slots.map((s) => ({ value: `${s.kind}:${s.name}`, label: clean(s.name, 120), detail: s.set ? 'set' : 'missing' })),
      sel: 0,
      onPick: (picked) => {
        const slot = slots.find((s) => `${s.kind}:${s.name}` === picked)
        if (slot) ask(slot)
      }
    })
  }

  /** l: add one of your library's entries to this project, for every role. */
  const addFromLibrary = (): void => {
    const servers = data!.servers
    act('Loading your library', async () => {
      const library = await api.mcpLibrary()
      const options = libraryOptions(Array.isArray(library) ? library : [], servers)
      if (!options.length) {
        setMessage({ text: 'Your library has no other server to add. Add one with: orgai mcp library add', tone: 'dim' })
        return
      }
      setDialog({
        kind: 'pick',
        title: 'Add a server from your library',
        options,
        sel: 0,
        onPick: (libraryId) => {
          const label = options.find((o) => o.value === libraryId)?.label ?? 'that server'
          save(() => api.linkMcp(projectId, libraryId), (next) => next.servers.find((s) => s.spec.libraryId === libraryId)?.spec.id, `Added ${label} for every role.`)
        }
      })
    })
  }

  /** x: take this server out of this project (a linked server keeps its library entry). */
  const remove = (): void => {
    const info = target!
    const name = clean(info.spec.name, 80)
    setDialog({
      kind: 'confirm',
      title: 'Confirm',
      lines: [`Remove ${name} from this project?`, '', 'Press y to remove, n or Esc to keep it.'],
      onYes: () => {
        setDetail(undefined)
        save(() => api.removeMcp(projectId, info.spec.id), undefined, `Removed ${name}.`)
      }
    })
  }

  const actions: Record<string, () => void> = { ' ': toggle, r: editRoles, s: editSecret, l: addFromLibrary, x: remove }

  const page = Math.max(1, contentSize(props.width, props.height, env, MCP_LIST_KEYS, message).bodyRows - 1)

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
        setDetail({ serverId: selected.id, offset: 0 })
        setMessage(undefined)
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

  const keys = dialog ? dialogKeys(dialog) : detail ? MCP_DETAIL_KEYS : MCP_LIST_KEYS
  const msg: Message | undefined = busy ? { text: `${busy}...`, tone: 'dim' } : message
  const { width: w, bodyRows } = contentSize(props.width, props.height, env, keys, msg)
  const title = detail && target ? `MCP ${separatorFor(env).trim()} ${clean(target.spec.name, 80)}` : `MCP servers${data ? ` of ${clean(data.project.name, 80)} (${data.servers.length} server${data.servers.length === 1 ? '' : 's'})` : ''}`
  let body: PaneLine[] = []
  if (dialog) body = dialogLines(dialog, w, bodyRows, env)
  else if (detail && data) {
    const lines = mcpDetailLines(data, detail.serverId)
    const max = Math.max(0, lines.length - bodyRows)
    const offset = Math.min(detail.offset, max)
    body = lines.slice(offset, offset + bodyRows).map((l, i) => ({ key: `d${offset + i}`, segs: l ? [{ text: truncateEnd(l, w, glyphs(env).ellipsis) }] : [] }))
  } else if (data) {
    if (rows.length === 0) body = [{ key: 'none', segs: [{ text: truncateEnd('This project has no MCP servers. Press l to add one from your library, or run: orgai mcp add', w, glyphs(env).ellipsis), dim: true }] }]
    else {
      const nameWidth = Math.min(28, Math.max(...rows.map((r) => textWidth(r.name))))
      const win = windowOf(rows, sel, bodyRows)
      body = win.items.map((r, i) => ({ key: r.id, segs: mcpRowSegs(r, w, nameWidth, separatorFor(env), glyphs(env).ellipsis, win.start + i === sel) }))
    }
  }
  return <ConfigFrame width={props.width} height={props.height} env={env} title={title} body={body} {...(msg ? { message: msg } : {})} keys={keys} />
}
