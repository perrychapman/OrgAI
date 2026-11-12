import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
const shell = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }
const dialog = { showSaveDialog: vi.fn() }
const win = { id: 'win' }
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void handlers.set(c, fn) },
  shell,
  dialog,
  BrowserWindow: { fromWebContents: (s: unknown) => (s ? win : null) }
}))
vi.mock('./log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

const { registerOutputsIpc: registerRaw } = await import('./outputsIpc')
const { DESKTOP_CHANNEL_MUTATES } = await import('./ipc')
const readOnlyCalls: string[] = []
const registerOutputsIpc = (d: Omit<Parameters<typeof registerRaw>[0], 'handleReadOnly'>): void =>
  registerRaw({
    ...d,
    handleReadOnly: (c, fn) => {
      readOnlyCalls.push(c)
      if (DESKTOP_CHANNEL_MUTATES[c] !== false) throw new Error(`${c} is not a read-only desktop-only channel`)
      handlers.set(c, fn as never)
    }
  })
const { OUTPUTS_IPC } = await import('@shared/types')
const { project: makeProject } = await import('./runtime/testHelpers')
type OutputsServiceApi = import('./outputs/api').OutputsServiceApi

const OID = 'out_0123456789abcdef'
const ref = { projectId: 'p1', outputId: OID }
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-outputs-ipc-'))
  handlers.clear()
  shell.openPath.mockClear()
  shell.showItemInFolder.mockClear()
  dialog.showSaveDialog.mockReset()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function register(over: Partial<OutputsServiceApi> = {}, withService = true) {
  const file = join(dir, 'report.docx')
  writeFileSync(file, 'DOCX BYTES')
  const service = {
    checkedPath: vi.fn(() => file),
    get: vi.fn(() => ({ fileName: 'report.docx' })),
    ...over
  } as unknown as OutputsServiceApi
  registerOutputsIpc({ outputs: withService ? service : undefined, projects: { get: (id) => (id === 'p1' ? makeProject({ id: 'p1', path: dir }) : null) }, dataDir: join(dir, 'data') })
  return { file, service }
}
const call = (channel: string, input: unknown = ref, sender: unknown = { id: 1 }): unknown => handlers.get(channel)!({ sender }, input)

describe('outputs desktop-only channels', () => {
  it('registers open, reveal, saveAs and saveImage', () => {
    register()
    expect([...handlers.keys()].sort()).toEqual([OUTPUTS_IPC.outputsOpen, OUTPUTS_IPC.outputsReveal, OUTPUTS_IPC.outputsSaveAs, OUTPUTS_IPC.outputsSaveImage].sort())
  })

  it('registers the four channels through the read-only path, classified non-mutating', () => {
    readOnlyCalls.length = 0
    register()
    expect([...readOnlyCalls].sort()).toEqual([OUTPUTS_IPC.outputsOpen, OUTPUTS_IPC.outputsReveal, OUTPUTS_IPC.outputsSaveAs, OUTPUTS_IPC.outputsSaveImage].sort())
    for (const c of readOnlyCalls) expect(DESKTOP_CHANNEL_MUTATES[c], c).toBe(false)
  })

  it('saveAs leaves exactly the destination on success and no partial file when the copy fails', async () => {
    const out = join(dir, 'out')
    mkdirSync(out)
    register()
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(out, 'copy.docx') })
    await call(OUTPUTS_IPC.outputsSaveAs)
    expect(readdirSync(out)).toEqual(['copy.docx'])
    register({ checkedPath: vi.fn(() => join(dir, 'missing.docx')) })
    const out2 = join(dir, 'out2')
    mkdirSync(out2)
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(out2, 'x.docx') })
    await expect(call(OUTPUTS_IPC.outputsSaveAs)).rejects.toThrow()
    expect(readdirSync(out2)).toEqual([])
  })

  it('open passes the checked path to shell.openPath and returns its answer', async () => {
    const { file, service } = register()
    shell.openPath.mockResolvedValueOnce('no app')
    await expect(call(OUTPUTS_IPC.outputsOpen)).resolves.toBe('no app')
    expect(shell.openPath).toHaveBeenCalledWith(file)
    expect(service.checkedPath).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', projectPath: dir }), OID)
    shell.openPath.mockResolvedValueOnce('')
    await expect(call(OUTPUTS_IPC.outputsOpen)).resolves.toBe('')
  })

  it('open refuses a launchable type even when the service would hand its path over; reveal still works', async () => {
    for (const name of ['x.lnk', 'x.bat', 'x.BaT', 'x.exe', 'report.docx.bat', 'x.docm', 'x.hta']) {
      const file = join(dir, name)
      writeFileSync(file, 'x')
      handlers.clear()
      shell.openPath.mockClear()
      shell.showItemInFolder.mockClear()
      registerOutputsIpc({
        outputs: { checkedPath: vi.fn(() => file), openablePath: undefined, get: vi.fn() } as unknown as OutputsServiceApi,
        projects: { get: () => makeProject({ id: 'p1', path: dir }) },
        dataDir: join(dir, 'data')
      })
      await expect(call(OUTPUTS_IPC.outputsOpen)).resolves.toBe('OrgAI does not open this kind of file. Use Show in folder instead.')
      expect(shell.openPath).not.toHaveBeenCalled()
      expect(call(OUTPUTS_IPC.outputsReveal)).toBe('')
      expect(shell.showItemInFolder).toHaveBeenCalledWith(file)
    }
  })

  it('reveal and saveAs re-check the entry on every call (saveAs again right before the copy) and work for non-openable files', async () => {
    const file = join(dir, 'tool.exe')
    writeFileSync(file, 'x')
    const checkedPath = vi.fn(() => file)
    register({ checkedPath })
    expect(call(OUTPUTS_IPC.outputsReveal)).toBe('')
    expect(checkedPath).toHaveBeenCalledTimes(1)
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(dir, 'copy.exe') })
    await call(OUTPUTS_IPC.outputsSaveAs)
    expect(checkedPath).toHaveBeenCalledTimes(3)
    expect(readFileSync(join(dir, 'copy.exe'), 'utf8')).toBe('x')
    checkedPath.mockImplementation(() => { throw new Error('gone') })
    expect(call(OUTPUTS_IPC.outputsReveal)).toBe('gone')
  })

  it('open re-checks the allowlist on the path the service returns (a service that skips it is not trusted)', async () => {
    const bad = join(dir, 'evil.bat')
    writeFileSync(bad, 'x')
    register({ openablePath: vi.fn(() => bad) })
    await expect(call(OUTPUTS_IPC.outputsOpen)).resolves.toMatch(/does not open this kind/)
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('open uses the service openablePath when present and relays its refusal', async () => {
    const { file, service } = register({ openablePath: vi.fn(() => join(dir, 'report.docx')) })
    await call(OUTPUTS_IPC.outputsOpen)
    expect(service.openablePath).toHaveBeenCalled()
    expect(shell.openPath).toHaveBeenCalledWith(file)
    register({ openablePath: vi.fn(() => { throw new Error('nope') }) })
    await expect(call(OUTPUTS_IPC.outputsOpen)).resolves.toBe('nope')
  })

  it('open and reveal turn a refusal into its sentence and never reject or open anything', async () => {
    register({
      checkedPath: vi.fn(() => {
        throw new Error('That file is a link, so OrgAI will not open it.')
      })
    })
    await expect(call(OUTPUTS_IPC.outputsOpen)).resolves.toBe('That file is a link, so OrgAI will not open it.')
    expect(call(OUTPUTS_IPC.outputsReveal)).toBe('That file is a link, so OrgAI will not open it.')
    await expect(call(OUTPUTS_IPC.outputsOpen, { projectId: 'p_nope', outputId: OID })).resolves.toBe('Project not found')
    await expect(call(OUTPUTS_IPC.outputsOpen, { projectId: 'quick', outputId: OID })).resolves.toBe('Assistants have no outputs.')
    await expect(call(OUTPUTS_IPC.outputsOpen, { projectId: 'p1', outputId: '../x' })).resolves.toBe('Output not found')
    await expect(call(OUTPUTS_IPC.outputsOpen, 'junk')).resolves.toBe('Project not found')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('reveal shows the checked path and answers an empty string', () => {
    const { file } = register()
    expect(call(OUTPUTS_IPC.outputsReveal)).toBe('')
    expect(shell.showItemInFolder).toHaveBeenCalledWith(file)
  })

  it('without a service every channel answers "Outputs are not available."', async () => {
    register({}, false)
    await expect(call(OUTPUTS_IPC.outputsOpen)).resolves.toBe('Outputs are not available.')
    expect(call(OUTPUTS_IPC.outputsReveal)).toBe('Outputs are not available.')
    await expect(Promise.resolve().then(() => call(OUTPUTS_IPC.outputsSaveAs))).rejects.toThrow('Outputs are not available.')
  })

  it('saveAs parents the dialog to the sender window, defaults to the file name and copies the file', async () => {
    const { service } = register()
    const target = join(dir, 'copy.docx')
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await expect(call(OUTPUTS_IPC.outputsSaveAs)).resolves.toEqual({ path: target })
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(win, { defaultPath: 'report.docx' })
    expect(readFileSync(target, 'utf8')).toBe('DOCX BYTES')
    // Checked before the dialog and again right before the copy.
    expect(service.checkedPath).toHaveBeenCalledTimes(2)
  })

  it('saveAs without a window uses the unparented dialog; a cancelled dialog copies nothing', async () => {
    const { service } = register()
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await expect(call(OUTPUTS_IPC.outputsSaveAs, ref, null)).resolves.toEqual({ cancelled: true })
    expect(dialog.showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'report.docx' })
    expect(service.checkedPath).toHaveBeenCalledTimes(1)
  })

  it('saveAs re-checks the path after the dialog: a file that became a refusal is not copied', async () => {
    let n = 0
    register({
      checkedPath: vi.fn(() => {
        if (++n > 1) throw new Error('That file changed and is no longer inside the project.')
        return join(dir, 'report.docx')
      })
    })
    const target = join(dir, 'never.docx')
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await expect(call(OUTPUTS_IPC.outputsSaveAs)).rejects.toThrow('no longer inside the project')
    expect(() => readFileSync(target)).toThrow()
  })
})

describe('outputs:open extends a watch', () => {
  it('touches the watcher for the output it opened, only after the path checks', async () => {
    const touch = vi.fn()
    const file = join(dir, 'report.docx')
    writeFileSync(file, 'x')
    registerOutputsIpc({
      outputs: { checkedPath: vi.fn(() => file), get: vi.fn() } as unknown as OutputsServiceApi,
      projects: { get: () => makeProject({ id: 'p1', path: dir }) },
      dataDir: join(dir, 'data'),
      watcher: { touch } as never
    })
    await call(OUTPUTS_IPC.outputsOpen)
    expect(touch).toHaveBeenCalledWith({ projectId: 'p1', outputId: OID })
    touch.mockClear()
    const bat = join(dir, 'x.bat')
    writeFileSync(bat, 'x')
    registerOutputsIpc({
      outputs: { checkedPath: vi.fn(() => bat), get: vi.fn() } as unknown as OutputsServiceApi,
      projects: { get: () => makeProject({ id: 'p1', path: dir }) },
      dataDir: join(dir, 'data'),
      watcher: { touch } as never
    })
    await call(OUTPUTS_IPC.outputsOpen)
    expect(touch).not.toHaveBeenCalled()
  })
})

describe('outputs:saveImage', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')])
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
  const input = (over: Record<string, unknown> = {}) => ({ ...ref, suggestedName: 'Architecture', mime: 'image/png', dataBase64: PNG.toString('base64'), ...over })

  it('saves a PNG to the path the dialog chose (temp + rename), parented to the sender, with a sanitized default name', async () => {
    const out = join(dir, 'out')
    mkdirSync(out)
    register()
    const target = join(out, 'diagram.png')
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await expect(call(OUTPUTS_IPC.outputsSaveImage, input({ suggestedName: '..\\..\\evil/Architecture: v2?.PNG' }))).resolves.toEqual({ path: target })
    expect(readFileSync(target)).toEqual(PNG)
    expect(readdirSync(out)).toEqual(['diagram.png'])
    const [parent, options] = dialog.showSaveDialog.mock.calls[0] as unknown as [unknown, { defaultPath: string; filters: { extensions: string[] }[] }]
    expect(parent).toBe(win)
    expect(options.defaultPath).toBe('Architecture v2.png')
    expect(options.filters[0].extensions).toEqual(['png'])
  })

  it('saves a plain SVG as text; a cancelled dialog writes nothing', async () => {
    register()
    const target = join(dir, 'd.svg')
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await call(OUTPUTS_IPC.outputsSaveImage, input({ mime: 'image/svg+xml', dataBase64: Buffer.from(SVG).toString('base64') }))
    expect(readFileSync(target, 'utf8')).toBe(SVG)
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await expect(call(OUTPUTS_IPC.outputsSaveImage, input())).resolves.toEqual({ cancelled: true })
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('refuses before any dialog: bad base64, a PNG without the signature, an SVG with a script, invalid UTF-8, too large, an unknown output', async () => {
    register()
    const refuse = async (over: Record<string, unknown>, text: string | RegExp): Promise<void> => {
      dialog.showSaveDialog.mockClear()
      await expect(Promise.resolve().then(() => call(OUTPUTS_IPC.outputsSaveImage, input(over)))).rejects.toThrow(text)
      expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    }
    await refuse({ dataBase64: 'not base64!' }, 'The picture is not valid.')
    await refuse({ dataBase64: 'AAA' }, 'The picture is not valid.')
    await refuse({ dataBase64: 'AA AA' }, 'The picture is not valid.')
    await refuse({ dataBase64: '' }, 'The picture is not valid.')
    await refuse({ dataBase64: Buffer.from('GIF89a....').toString('base64') }, 'That is not a PNG picture.')
    await refuse({ mime: 'image/svg+xml', dataBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64') }, /active content/)
    await refuse({ mime: 'image/svg+xml', dataBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>').toString('base64') }, /active content/)
    await refuse({ mime: 'image/svg+xml', dataBase64: Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe, 0x3e]).toString('base64') }, 'The drawing is not valid text.')
    await refuse({ dataBase64: 'A'.repeat(Math.ceil((25 * 1024 * 1024 + 1000) / 3) * 4) }, /too (large|long)/)
    register({ get: vi.fn(() => undefined) })
    await refuse({}, 'Output not found')
  })

  it('the path comes only from the dialog: a path field in the input is dropped, and a virtual or unknown project is refused', async () => {
    register()
    const target = join(dir, 'p.png')
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await call(OUTPUTS_IPC.outputsSaveImage, input({ path: join(dir, 'other.png'), filePath: join(dir, 'other2.png') }))
    expect(readdirSync(dir).sort()).toEqual(['p.png', 'report.docx'])
    await expect(Promise.resolve().then(() => call(OUTPUTS_IPC.outputsSaveImage, input({ projectId: 'quick' })))).rejects.toThrow('Assistants have no outputs.')
    await expect(Promise.resolve().then(() => call(OUTPUTS_IPC.outputsSaveImage, input({ projectId: 'p_nope' })))).rejects.toThrow('Project not found')
  })

  it('no partial file stays when the write fails (the destination folder is gone)', async () => {
    register()
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(dir, 'nope', 'x.png') })
    await expect(call(OUTPUTS_IPC.outputsSaveImage, input())).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['report.docx'])
  })

  it('exportImageName strips folders, extensions and forbidden characters, avoids reserved names and falls back', async () => {
    const { exportImageName } = await import('./outputsIpc')
    expect(exportImageName('..\\a/b/Map.svg', 'image/png', 'T')).toBe('Map.png')
    expect(exportImageName('NUL', 'image/png', 'T')).toBe('_NUL.png')
    expect(exportImageName('', 'image/svg+xml', 'Big map')).toBe('Big map.svg')
    expect(exportImageName('  ... ', 'image/png', '')).toBe('diagram.png')
    expect(exportImageName('a'.repeat(300), 'image/png', 'T')).toHaveLength(104)
    expect(exportImageName('x\u0000y|z', 'image/png', 'T')).toBe('xyz.png')
  })
})
