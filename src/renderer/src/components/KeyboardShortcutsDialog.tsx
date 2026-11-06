import { Fragment, type ReactElement } from 'react'
import '../styles/menu.css'
import { SHORTCUTS, isMacPlatform, keyLabel, type ShortcutDef } from '../lib/menuActions'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'

const GROUPS: ShortcutDef['group'][] = ['General', 'Runs', 'Canvas']

/** Every keyboard shortcut, from the one SHORTCUTS table. Cmd on a Mac, Ctrl elsewhere. */
export default function KeyboardShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement {
  const mac = isMacPlatform()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      size="md"
      testId="keyboard-shortcuts-dialog"
      footer={
        <Button autoFocusDialog onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="shortcuts">
        {GROUPS.map((group) => (
          <section key={group} className="shortcuts-group" aria-labelledby={`shortcuts-${group}`}>
            <h3 id={`shortcuts-${group}`}>{group}</h3>
            <table className="shortcuts-table">
              <tbody>
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <tr key={s.label}>
                    <th scope="row">
                      {s.label}
                      {s.note && <span className="shortcuts-note">{s.note}</span>}
                    </th>
                    <td>
                      <span className="shortcuts-keys">
                        {s.combos.map((combo, i) => (
                          <Fragment key={combo.join('+')}>
                            {i > 0 && <span className="shortcuts-or">or</span>}
                            <span className="shortcuts-combo">
                              {combo.map((k) => (
                                <kbd key={k}>{keyLabel(k, mac)}</kbd>
                              ))}
                            </span>
                          </Fragment>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
