import type { ReactElement } from 'react'
import { useId } from 'react'
import type { TeamFilesFound } from '@shared/types'
import { hasHidden, showHidden } from '../../lib/hiddenChars'
import {
  OTHER_TOOLS_LINE,
  TEAM_EXISTING_REASON,
  TEAM_FOUND_TITLE,
  approvalChanges,
  changeForServer,
  roleElevated,
  teamFoundCounts
} from '../../lib/teamFound'
import { ClampText } from '../proposals/ClampText'
import '../../styles/teamFound.css'

/** Untrusted repository text, shown as data: hidden characters become visible escapes and get a badge. */
function Data({ text, mono }: { text: string; mono?: boolean }): ReactElement {
  return (
    <>
      <span className={mono ? 'mono' : undefined}>{showHidden(text)}</span>
      {hasHidden(text) && (
        <span className="chip warn tf-hidden" title="This text holds characters that cannot be seen. They are shown as \\u codes.">
          Hidden characters shown
        </span>
      )}
    </>
  )
}

/**
 * New project: the folder already holds a team (`.orgai/`). Shows what it contains so the user reviews it before the
 * project is created from it. With `existingName` only the one-sentence reason is shown (nothing is created).
 */
export function TeamFoundPanel({
  found,
  existingName,
  blocker,
  otherToolAgents
}: {
  found: TeamFilesFound
  existingName?: string
  blocker: string | null
  otherToolAgents: number
}): ReactElement {
  const uid = useId()
  const power = approvalChanges(found)
  const settings = found.settings ?? []
  return (
    <section className="team-found" data-testid="team-found" aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`} className="team-found-title">
        {TEAM_FOUND_TITLE}
      </h3>
      <p className="team-found-counts" data-testid="team-found-counts">
        {teamFoundCounts(found)}, stored as files in the folder.
      </p>
      {existingName ? (
        <p className="field-msg warn" data-testid="team-found-existing">
          {TEAM_EXISTING_REASON} Open {existingName} instead.
        </p>
      ) : (
        <>
          <p className="hint">The project starts with this team instead of the default chart. Read it first: it comes from files in the folder.</p>
          {blocker && (
            <p className="field-msg error" data-testid="team-found-blocker">
              {blocker}
            </p>
          )}
          {found.problems.length > 0 && (
            <ul className="team-found-list" aria-label="Problems in the team files" data-testid="team-found-problems">
              {found.problems.map((p, i) => (
                <li key={i} className="team-found-problem">
                  <span className="mono">
                    <Data text={p.file} />
                  </span>
                  <span>
                    <Data text={p.message} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {found.warnings.length > 0 && (
            <ul className="team-found-list" aria-label="Warnings about the team files" data-testid="team-found-warnings">
              {found.warnings.map((w, i) => (
                <li key={i} className="team-found-warning">
                  <span className="chip warn">Warning</span>
                  <span className="mono">
                    <Data text={w.file} />
                  </span>
                  <span>
                    <Data text={w.message} />
                  </span>
                </li>
              ))}
            </ul>
          )}

          {power.length > 0 && (
            <div className="team-found-block">
              <h4>What you are agreeing to</h4>
              <ul className="team-found-list team-found-scroll" tabIndex={0} aria-label="Changes that need your approval, most powerful first" data-testid="team-found-changes">
                {power.map((c) => (
                  <li key={c.id} className="team-found-change" data-testid="team-found-change" data-kind={c.kind}>
                    <span>
                      <Data text={c.summary} />
                    </span>
                    {c.reason && (
                      <span className="chip warn">
                        <Data text={c.reason} />
                      </span>
                    )}
                    <span className="mono muted team-found-file">
                      <Data text={c.file} />
                    </span>
                  </li>
                ))}
              </ul>
              {(found.omittedChanges ?? 0) > 0 && <p className="hint">Some changes are not listed.</p>}
            </div>
          )}

          <div className="team-found-block">
            <h4>Roles</h4>
            <ul className="team-found-list" data-testid="team-found-roles">
              {found.roles.map((r) => {
                const labels = roleElevated(r.elevated)
                return (
                  <li key={r.slug} className="team-found-role" data-testid="team-found-role" data-slug={r.slug}>
                    <details open={labels.length > 0}>
                      <summary>
                        <strong>
                          <Data text={r.name} />
                        </strong>
                        {labels.map((l) => (
                          <span key={l} className="chip warn">
                            {l}
                          </span>
                        ))}
                        <span className="muted team-found-reports">{r.reportsTo ? <>Reports to <Data text={r.reportsTo} /></> : 'Top of the chart'}</span>
                      </summary>
                      <div className="team-found-body">
                        <p className="team-found-tools">
                          {r.tools.length > 0 ? (
                            <>
                              <span className="muted">Granted: </span>
                              {r.tools.map((t) => (
                                <span key={t} className="chip mono">
                                  <Data text={t} />
                                </span>
                              ))}
                            </>
                          ) : (
                            <span className="muted">No tools granted.</span>
                          )}
                        </p>
                        <ClampText text={r.prompt} label={`${r.name} prompt`} />
                      </div>
                    </details>
                  </li>
                )
              })}
            </ul>
          </div>

          {found.skills.length > 0 && (
            <div className="team-found-block">
              <h4>Skills</h4>
              <ul className="team-found-list" data-testid="team-found-skills">
                {found.skills.map((s, i) => (
                  <li key={`${s.name}-${i}`} className="team-found-skill" data-testid="team-found-skill">
                    <strong>
                      <Data text={s.name} />
                    </strong>
                    {s.scripts.length > 0 && <span className="chip warn">Has scripts</span>}
                    {s.description && (
                      <span className="muted">
                        <Data text={s.description} />
                      </span>
                    )}
                    {s.scripts.length > 0 && (
                      <span className="mono team-found-file">
                        <span className="muted">Scripts: </span>
                        <Data text={s.scripts.join(', ')} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {found.mcpServers.length > 0 && (
            <div className="team-found-block">
              <h4>Connected services</h4>
              <ul className="team-found-list" data-testid="team-found-servers">
                {found.mcpServers.map((m, i) => {
                  const change = changeForServer(found.changes, m.name)
                  return (
                    <li key={`${m.name}-${i}`} className="team-found-server" data-testid="team-found-server" data-name={m.name}>
                      <strong>
                        <Data text={m.name} />
                      </strong>
                      <code className="team-found-target">
                        <Data text={m.target} />
                      </code>
                      {m.secretNames.length > 0 && (
                        <span>
                          <span className="muted">Needs secrets, set on this computer: </span>
                          <Data text={m.secretNames.join(', ')} mono />
                        </span>
                      )}
                      {change?.usesStoredSignIn && <span className="chip">Uses the sign-in stored on this computer</span>}
                      {change?.summary && (
                        <span className="muted">
                          <Data text={change.summary} />
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {settings.length > 0 && (
            <div className="team-found-block">
              <h4>Settings</h4>
              <dl className="team-found-settings" data-testid="team-found-settings">
                {settings.map((s, i) => (
                  <div key={`${s.label}-${i}`} className="team-found-setting">
                    <dt>
                      <Data text={s.label} />
                    </dt>
                    <dd>
                      <Data text={s.value} />
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {otherToolAgents > 0 && (
            <p className="hint" data-testid="team-found-other-tools">
              {OTHER_TOOLS_LINE}
            </p>
          )}
        </>
      )}
    </section>
  )
}
