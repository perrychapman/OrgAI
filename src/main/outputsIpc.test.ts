import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const { registerOutputsIpc } = await import('./outputsIpc')
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
  it('registers open, reveal and saveAs', () => {
    register()
    expect([...handlers.keys()].sort()).toEqual([OUTPUTS_IPC.outputsOpen, OUTPUTS_IPC.outputsReveal, OUTPUTS_IPC.outputsSaveAs])
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
